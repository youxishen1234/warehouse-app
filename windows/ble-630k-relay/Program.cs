using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

namespace Warehouse.Ble630KRelay
{
    internal static class Program
    {
        internal static readonly Guid ServiceUuid = Guid.Parse("8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021");
        internal static readonly Guid ControlUuid = Guid.Parse("8f0b5d8e-6b6d-42d9-9b80-5f3257a0f022");
        internal static readonly Guid InfoUuid = Guid.Parse("8f0b5d8e-6b6d-42d9-9b80-5f3257a0f023");
        internal static readonly Guid DataUuid = Guid.Parse("8f0b5d8e-6b6d-42d9-9b80-5f3257a0f024");
        internal static readonly Guid StatusUuid = Guid.Parse("8f0b5d8e-6b6d-42d9-9b80-5f3257a0f025");

        [STAThread]
        internal static int Main()
        {
            using (var mutex = new Mutex(true, @"Local\Warehouse630KBleRelay", out bool created))
            {
                if (!created)
                {
                    Console.Error.WriteLine("另一个 630K 蓝牙中继正在运行");
                    return 2;
                }

                try
                {
                    return RelayHost.Run();
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.ToString());
                    return 1;
                }
                finally
                {
                    mutex.ReleaseMutex();
                }
            }
        }

        internal static Guid RelayId()
        {
            byte[] digest;
            using (var sha = SHA256.Create())
                digest = sha.ComputeHash(Encoding.UTF8.GetBytes("630K|" + Environment.MachineName));
            var bytes = digest.Take(16).ToArray();
            // Guid serializes its third field little-endian, so the canonical
            // UUID version nibble is held in byte 7 rather than byte 6.
            bytes[7] = (byte)((bytes[7] & 0x0f) | 0x50);
            bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
            return new Guid(bytes);
        }
    }

    internal sealed class RelayHost
    {
        private const int MaxPayload = 512 * 1024;
        private const int MaxChunk = 180;
        private const int MaxStatusBytes = 512;
        private const int MaxJobStates = 256;
        private const int MaxControlBytes = 4096;
        private const int MaxControlAssemblies = 16;
        private const int MaxStatusReadSnapshots = 16;
        private static readonly TimeSpan ControlIdleTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan TransferIdleTimeout = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan JobWaitTimeout = TimeSpan.FromSeconds(120);
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly object _gate = new object();
        private readonly object _jsonGate = new object();
        private readonly object _advertisingGate = new object();
        private readonly Dictionary<string, Dictionary<string, object>> _jobStates =
            new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        private readonly Dictionary<string, ControlAssembly> _controlAssemblies =
            new Dictionary<string, ControlAssembly>(StringComparer.Ordinal);
        private readonly Dictionary<string, StatusReadSnapshot> _statusReadSnapshots =
            new Dictionary<string, StatusReadSnapshot>(StringComparer.Ordinal);
        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        private readonly string _endpoint;
        private readonly string _capability;
        private readonly string _name;
        private readonly int _parentPid;
        private readonly bool _debug;
        private readonly string _relayId = Program.RelayId().ToString();
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = MaxPayload + 64 * 1024 };
        private GattServiceProvider _provider;
        private GattLocalCharacteristic _control;
        private GattLocalCharacteristic _info;
        private GattLocalCharacteristic _data;
        private GattLocalCharacteristic _status;
        private Transfer _transfer;
        private DateTime _lastTransferActivity = DateTime.UtcNow;
        private string _statusJson;
        private bool _advertising;
        private Exception _advertisingFailure;

        private RelayHost()
        {
            _endpoint = (Environment.GetEnvironmentVariable("WAREHOUSE_BLE_API") ?? string.Empty).TrimEnd('/');
            _capability = Environment.GetEnvironmentVariable("WAREHOUSE_BLE_TOKEN") ?? string.Empty;
            _name = (Environment.GetEnvironmentVariable("WAREHOUSE_BLE_NAME") ?? "Warehouse-630K-Relay").Trim();
            _debug = Environment.GetEnvironmentVariable("WAREHOUSE_BLE_DEBUG") == "1";
            int.TryParse(Environment.GetEnvironmentVariable("WAREHOUSE_BLE_PARENT_PID"), out _parentPid);
            if (!Uri.TryCreate(_endpoint, UriKind.Absolute, out Uri uri)
                || uri.Host != "127.0.0.1"
                || uri.Scheme != Uri.UriSchemeHttp)
                throw new InvalidOperationException("本地蓝牙中继地址无效");
            if (_capability.Length < 32)
                throw new InvalidOperationException("本地蓝牙中继凭据无效");
            if (_name.Length == 0 || _name.Length > 32)
                throw new InvalidOperationException("蓝牙名称须为 1 至 32 个字符");
            _statusJson = StatusJson(string.Empty, "received", "等待手机发送打印任务", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        internal static int Run()
        {
            return new RelayHost().RunCore();
        }

        private int RunCore()
        {
            Task[] watchers = new Task[0];
            try
            {
                CheckAdapter();
                WaitForReceiver();
                CreateServer();
                WaitForAdvertising();
                Console.Out.WriteLine("READY");
                watchers = new[]
                {
                    Task.Run(() => WatchParentAsync()),
                    Task.Run(() => ExpireTransfersAsync()),
                    Task.Run(() => WatchAdvertisingAsync()),
                };
                WaitForStop();
                if (_advertisingFailure != null)
                    throw new InvalidOperationException("蓝牙广播持续不可用", _advertisingFailure);
                return 0;
            }
            finally
            {
                _stop.Cancel();
                StopAdvertising();
                DetachHandlers();
                try { Task.WaitAll(watchers, 3000); } catch { }
                _http.Dispose();
            }
        }

        private static void CheckAdapter()
        {
            var adapter = BluetoothAdapter.GetDefaultAsync().AsTask().GetAwaiter().GetResult();
            if (adapter == null) throw new InvalidOperationException("未找到 Windows 蓝牙适配器");
            if (!adapter.IsLowEnergySupported) throw new InvalidOperationException("蓝牙适配器不支持低功耗蓝牙");
            if (!adapter.IsPeripheralRoleSupported) throw new InvalidOperationException("蓝牙适配器不支持外设模式");
        }

        private void WaitForReceiver()
        {
            Exception last = null;
            for (var attempt = 0; attempt < 30 && !_stop.IsCancellationRequested; attempt++)
            {
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, _endpoint + "/v1/health"))
                    {
                        request.Headers.TryAddWithoutValidation("X-Warehouse-Ble-Relay", _capability);
                        using (var response = _http.SendAsync(request, _stop.Token).GetAwaiter().GetResult())
                        {
                            if (response.IsSuccessStatusCode) return;
                        }
                    }
                }
                catch (Exception error)
                {
                    last = error;
                }
                Thread.Sleep(500);
            }
            throw new InvalidOperationException("无法连接本机打印接收程序", last);
        }

        private void CreateServer()
        {
            var created = GattServiceProvider.CreateAsync(Program.ServiceUuid).AsTask().GetAwaiter().GetResult();
            if (created.Error != BluetoothError.Success || created.ServiceProvider == null)
                throw new InvalidOperationException("创建蓝牙服务失败：" + created.Error);
            _provider = created.ServiceProvider;

            var infoParameters = new GattLocalCharacteristicParameters
            {
                CharacteristicProperties = GattCharacteristicProperties.Read,
                ReadProtectionLevel = GattProtectionLevel.Plain,
                UserDescription = "630K relay info",
                StaticValue = Buffer(Encoding.UTF8.GetBytes(RelayInfoJson())),
            };
            _info = _provider.Service.CreateCharacteristicAsync(Program.InfoUuid, infoParameters).AsTask().GetAwaiter().GetResult().Characteristic;
            if (_info == null) throw new InvalidOperationException("创建蓝牙信息特征失败");

            var controlParameters = new GattLocalCharacteristicParameters
            {
                CharacteristicProperties = GattCharacteristicProperties.Write,
                WriteProtectionLevel = GattProtectionLevel.EncryptionRequired,
                UserDescription = "630K encrypted control",
            };
            var controlResult = _provider.Service.CreateCharacteristicAsync(Program.ControlUuid, controlParameters).AsTask().GetAwaiter().GetResult();
            if (controlResult.Error != BluetoothError.Success || controlResult.Characteristic == null)
                throw new InvalidOperationException("创建蓝牙控制特征失败：" + controlResult.Error);
            _control = controlResult.Characteristic;

            var dataParameters = new GattLocalCharacteristicParameters
            {
                CharacteristicProperties = GattCharacteristicProperties.Write |
                                           GattCharacteristicProperties.WriteWithoutResponse,
                WriteProtectionLevel = GattProtectionLevel.EncryptionRequired,
                UserDescription = "630K encrypted job bytes",
            };
            var dataResult = _provider.Service.CreateCharacteristicAsync(Program.DataUuid, dataParameters).AsTask().GetAwaiter().GetResult();
            if (dataResult.Error != BluetoothError.Success || dataResult.Characteristic == null)
                throw new InvalidOperationException("创建蓝牙数据特征失败：" + dataResult.Error);
            _data = dataResult.Characteristic;

            var statusParameters = new GattLocalCharacteristicParameters
            {
                CharacteristicProperties = GattCharacteristicProperties.Read |
                                           GattCharacteristicProperties.Notify,
                ReadProtectionLevel = GattProtectionLevel.EncryptionRequired,
                UserDescription = "630K encrypted status",
            };
            var statusResult = _provider.Service.CreateCharacteristicAsync(Program.StatusUuid, statusParameters).AsTask().GetAwaiter().GetResult();
            if (statusResult.Error != BluetoothError.Success || statusResult.Characteristic == null)
                throw new InvalidOperationException("创建蓝牙状态特征失败：" + statusResult.Error);
            _status = statusResult.Characteristic;

            _control.WriteRequested += OnControlWrite;
            _data.WriteRequested += OnDataWrite;
            _status.ReadRequested += OnStatusRead;
            StartAdvertising();
        }

        private string RelayInfoJson()
        {
            return Json(new Dictionary<string, object>
            {
                ["v"] = 1,
                ["relayId"] = _relayId,
                ["name"] = _name,
                ["maxPayload"] = MaxPayload,
                ["chunkSize"] = MaxChunk,
            });
        }

        private void StartAdvertising()
        {
            lock (_advertisingGate)
            {
                _stop.Token.ThrowIfCancellationRequested();
                if (_provider == null) throw new InvalidOperationException("蓝牙服务尚未创建");
                if (_advertising
                    && _provider.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Started)
                    return;
                _provider.StartAdvertising(new GattServiceProviderAdvertisingParameters
                {
                    IsConnectable = true,
                    IsDiscoverable = true,
                });
                _advertising = true;
            }
        }

        private void WaitForAdvertising()
        {
            var deadline = DateTime.UtcNow.AddSeconds(10);
            GattServiceProviderAdvertisementStatus? lastStatus = null;
            while (DateTime.UtcNow < deadline)
            {
                var status = _provider.AdvertisementStatus;
                if (_debug && status != lastStatus)
                {
                    Console.Error.WriteLine("ADVERTISEMENT_STATUS=" + status);
                    lastStatus = status;
                }
                if (status == GattServiceProviderAdvertisementStatus.Started) return;
                Thread.Sleep(100);
            }
            throw new InvalidOperationException("蓝牙广播未在启动期限内就绪：" + _provider.AdvertisementStatus);
        }

        private async Task WatchAdvertisingAsync()
        {
            GattServiceProviderAdvertisementStatus? lastStatus = null;
            DateTime? unavailableSince = null;
            var nextRetry = DateTime.MinValue;
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    await Task.Delay(500, _stop.Token);
                    var status = _provider.AdvertisementStatus;
                    if (_debug && status != lastStatus)
                    {
                        Console.Error.WriteLine("ADVERTISEMENT_STATUS=" + status);
                        lastStatus = status;
                    }
                    if (status == GattServiceProviderAdvertisementStatus.Started)
                    {
                        unavailableSince = null;
                        continue;
                    }
                    var now = DateTime.UtcNow;
                    if (!unavailableSince.HasValue) unavailableSince = now;
                    if (now - unavailableSince.Value > TimeSpan.FromSeconds(15))
                        throw new InvalidOperationException("蓝牙广播状态未恢复：" + status);
                    if ((status == GattServiceProviderAdvertisementStatus.Aborted
                        || status == GattServiceProviderAdvertisementStatus.Stopped) && now >= nextRetry)
                    {
                        nextRetry = now.AddSeconds(2);
                        try { _advertising = false; StartAdvertising(); }
                        catch (Exception error) { Console.Error.WriteLine("蓝牙广播恢复失败：" + error.Message); }
                    }
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (Exception error)
            {
                _advertisingFailure = error;
                _stop.Cancel();
            }
        }

        private void StopAdvertising()
        {
            lock (_advertisingGate)
            {
                try { if (_provider != null) _provider.StopAdvertising(); }
                catch { }
                _advertising = false;
            }
        }

        private async void OnControlWrite(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
        {
            using (var deferral = args.GetDeferral())
            {
                GattWriteRequest request = null;
                var errorJobId = string.Empty;
                try
                {
                    request = await args.GetRequestAsync();
                    if (request == null) return;
                    var payload = BufferBytes(request.Value);
                    var sessionId = SessionId(args);
                    if (request.Offset != 0 || payload.Length > MaxControlBytes)
                        throw new ProtocolException("控制命令过大或使用了不支持的写入偏移");
                    if (request.Option != GattWriteOption.WriteWithResponse)
                        throw new ProtocolException("控制命令必须使用有响应写入");
                    payload = AcceptControlFrame(sessionId, payload);
                    if (payload == null)
                    {
                        Respond(request);
                        return;
                    }

                    Dictionary<string, object> command;
                    try
                    {
                        command = DeserializeObject(StrictUtf8.GetString(payload));
                    }
                    catch
                    {
                        throw new ProtocolException("控制命令不是有效 JSON");
                    }
                    var op = Text(command, "op");
                    errorJobId = Text(command, "id") ?? string.Empty;
                    if (op != "hello" && !ValidId(errorJobId))
                        throw new ProtocolException("打印任务编号无效");
                    switch (op)
                    {
                        case "hello":
                            RequireKeys(command, "v", "op");
                            if (Integer(command, "v") != 1) throw new ProtocolException("协议版本无效");
                            Respond(request);
                            return;
                        case "begin":
                            RequireKeys(command, "v", "op", "id", "length", "sha256", "paper");
                            if (Integer(command, "v") != 1) throw new ProtocolException("协议版本无效");
                            Begin(Text(command, "id"), Integer(command, "length"), Text(command, "sha256"),
                                Text(command, "paper"), sessionId);
                            Respond(request);
                            return;
                        case "commit":
                            RequireKeys(command, "v", "op", "id");
                            if (Integer(command, "v") != 1) throw new ProtocolException("协议版本无效");
                            var committed = Commit(Text(command, "id"), sessionId);
                            await SubmitAsync(committed);
                            Respond(request);
                            return;
                        case "status":
                            RequireKeys(command, "v", "op", "id");
                            if (Integer(command, "v") != 1) throw new ProtocolException("协议版本无效");
                            await RefreshStatusAsync(Text(command, "id"), sessionId);
                            Respond(request);
                            return;
                        case "resolve":
                            RequireKeys(command, "v", "op", "id", "outcome");
                            if (Integer(command, "v") != 1) throw new ProtocolException("协议版本无效");
                            var outcome = Text(command, "outcome");
                            if (outcome != "printed" && outcome != "missing") throw new ProtocolException("核对结果无效");
                            await ResolveAsync(Text(command, "id"), outcome);
                            Respond(request);
                            return;
                        default:
                            throw new ProtocolException("不支持的控制命令");
                    }
                }
                catch (Exception error)
                {
                    var message = error is ProtocolException ? error.Message : "控制命令处理失败";
                    PublishProtocolFailure(errorJobId, message);
                    RespondWithError(request, 0x80);
                }
                finally
                {
                    deferral.Complete();
                }
            }
        }

        private async void OnDataWrite(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
        {
            using (var deferral = args.GetDeferral())
            {
                GattWriteRequest request = null;
                try
                {
                    request = await args.GetRequestAsync();
                    if (request == null) return;
                    if (request.Offset != 0) throw new ProtocolException("数据写入必须从偏移 0 开始");
                    var frame = BufferBytes(request.Value);
                    if (frame.Length <= 4 || frame.Length > MaxChunk + 4)
                        throw new ProtocolException("蓝牙数据块大小无效");
                    var ordinal = ((uint)frame[0] << 24) | ((uint)frame[1] << 16) | ((uint)frame[2] << 8) | frame[3];
                    bool failed;
                    lock (_gate) failed = AppendChunk(SessionId(args), ordinal, frame.Skip(4).ToArray());
                    if (request.Option == GattWriteOption.WriteWithResponse)
                    {
                        if (failed) RespondWithError(request, 0x80);
                        else Respond(request);
                    }
                }
                catch (Exception error)
                {
                    var message = error is ProtocolException ? error.Message : "蓝牙数据写入失败";
                    PublishProtocolFailure(string.Empty, message);
                    RespondWithError(request, 0x80);
                }
                finally
                {
                    deferral.Complete();
                }
            }
        }

        private async void OnStatusRead(GattLocalCharacteristic sender, GattReadRequestedEventArgs args)
        {
            using (var deferral = args.GetDeferral())
            {
                GattReadRequest request = null;
                try
                {
                    request = await args.GetRequestAsync();
                    if (request == null) return;
                    var value = ReadStatusValue(request.Offset, SessionId(args));
                    request.RespondWithValue(Buffer(value));
                }
                catch (Exception error)
                {
                    try
                    {
                        if (request != null && request.State == GattRequestState.Pending)
                            request.RespondWithProtocolError(error is ProtocolException protocol ? protocol.AttError : (byte)0x80);
                    }
                    catch { }
                }
                finally
                {
                    deferral.Complete();
                }
            }
        }

        private byte[] AcceptControlFrame(string sessionId, byte[] frame)
        {
            if (string.IsNullOrEmpty(sessionId) || frame == null || frame.Length == 0)
                throw new ProtocolException("控制命令内容为空");
            if (frame[0] != 0xb6)
            {
                if (frame.Length > MaxControlBytes) throw new ProtocolException("控制命令超过 4096 字节");
                return frame;
            }
            if (frame.Length < 10) throw new ProtocolException("控制命令分帧头无效");
            var commandId = (frame[1] << 8) | frame[2];
            var total = (frame[3] << 8) | frame[4];
            var offset = (frame[5] << 8) | frame[6];
            var length = (frame[7] << 8) | frame[8];
            if (total == 0 || total > MaxControlBytes || length == 0
                || frame.Length != 9 + length || offset + length > total)
                throw new ProtocolException("控制命令分帧长度无效");
            var key = sessionId.Length.ToString(CultureInfo.InvariantCulture) + ":" + sessionId + ":" + commandId;
            lock (_gate)
            {
                var now = DateTime.UtcNow;
                ExpireControlAssembliesLocked(now);
                if (!_controlAssemblies.TryGetValue(key, out var assembly))
                {
                    if (offset != 0) throw new ProtocolException("控制命令分帧必须从偏移 0 开始");
                    if (_controlAssemblies.Count >= MaxControlAssemblies)
                        throw new ProtocolException("正在接收的控制命令过多，请稍后重试");
                    _controlAssemblies[key] = assembly = new ControlAssembly(total, now);
                }
                if (assembly.Bytes.Length != total || assembly.NextOffset != offset)
                {
                    _controlAssemblies.Remove(key);
                    throw new ProtocolException("控制命令分帧重复、乱序或长度不一致");
                }
                System.Buffer.BlockCopy(frame, 9, assembly.Bytes, offset, length);
                assembly.NextOffset += length;
                assembly.UpdatedAt = now;
                if (assembly.NextOffset != total) return null;
                _controlAssemblies.Remove(key);
                return assembly.Bytes;
            }
        }

        private void ExpireControlAssembliesLocked(DateTime now)
        {
            foreach (var key in _controlAssemblies
                .Where(pair => pair.Value.UpdatedAt < now - ControlIdleTimeout)
                .Select(pair => pair.Key).ToArray())
                _controlAssemblies.Remove(key);
            foreach (var key in _statusReadSnapshots
                .Where(pair => pair.Value.UpdatedAt < now - ControlIdleTimeout)
                .Select(pair => pair.Key).ToArray())
                _statusReadSnapshots.Remove(key);
        }

        private byte[] ReadStatusValue(uint offset, string sessionId)
        {
            lock (_gate)
            {
                var now = DateTime.UtcNow;
                ExpireControlAssembliesLocked(now);
                StatusReadSnapshot snapshot;
                if (offset == 0 || !_statusReadSnapshots.TryGetValue(sessionId, out snapshot))
                {
                    snapshot = new StatusReadSnapshot { Bytes = Encoding.UTF8.GetBytes(_statusJson), UpdatedAt = now };
                    if (!_statusReadSnapshots.ContainsKey(sessionId) && _statusReadSnapshots.Count >= MaxStatusReadSnapshots)
                    {
                        var oldest = _statusReadSnapshots.OrderBy(pair => pair.Value.UpdatedAt).First().Key;
                        _statusReadSnapshots.Remove(oldest);
                    }
                    _statusReadSnapshots[sessionId] = snapshot;
                }
                if (offset > snapshot.Bytes.Length)
                    throw new ProtocolException("状态读取偏移无效", 0x07);
                snapshot.UpdatedAt = now;
                return snapshot.Bytes.Skip((int)offset).ToArray();
            }
        }

        private void PublishProtocolFailure(string id, string message)
        {
            lock (_gate)
            {
                if (_transfer != null && _jobStates.TryGetValue(_transfer.Id, out var active))
                    _statusJson = StatusJsonFromRowLocked(active);
                else if (ValidId(id) && _jobStates.TryGetValue(id, out var existing))
                    _statusJson = StatusJsonFromRowLocked(existing);
                else
                    _statusJson = StatusJson(ValidId(id) ? id : string.Empty, "failed", message, Now(), "INVALID_PROTOCOL");
            }
            _ = NotifyStatusAsync();
        }

        private void Begin(string id, long length, string sha256, string paper, string sessionId)
        {
            if (!ValidId(id)) throw new ProtocolException("打印任务编号无效");
            if (length <= 0 || length > MaxPayload) throw new ProtocolException("打印任务超过 512 KiB");
            if (!IsSha256(sha256)) throw new ProtocolException("打印任务校验值无效");
            if (!new[] { "241-93", "241-140", "241-279", "a4", "custom" }.Contains(paper))
                throw new ProtocolException("打印纸张无效");
            if (string.IsNullOrEmpty(sessionId)) throw new ProtocolException("无法确认蓝牙连接会话");
            lock (_gate)
            {
                if (_transfer != null && _lastTransferActivity < DateTime.UtcNow - TransferIdleTimeout)
                {
                    var expired = _transfer;
                    _transfer = null;
                    SetStatusLocked(expired.Id, "failed", "打印资料接收超时，可以重新发送");
                }
                if (_transfer != null) throw new ProtocolException("已有打印资料正在接收，请等待完成或超时");
                if (_jobStates.TryGetValue(id, out var existing)
                    && (Text(existing, "status") != "failed" || existing.ContainsKey("confirmedPrintedAt")))
                {
                    _statusJson = StatusJsonFromRowLocked(existing);
                    throw new ProtocolException("该打印任务编号已经接收，请查询原任务");
                }
                _transfer = new Transfer
                {
                    Id = id,
                    Length = (int)length,
                    Sha256 = sha256,
                    Paper = paper,
                    SessionId = sessionId,
                    StartedAt = DateTime.UtcNow,
                };
                _lastTransferActivity = DateTime.UtcNow;
                SetStatusLocked(id, "received", "正在接收打印资料");
                _jobStates[id]["durable"] = false;
                _jobStates[id]["commitStarted"] = false;
            }
            _ = NotifyStatusAsync();
        }

        private bool AppendChunk(string sessionId, uint ordinal, byte[] payload)
        {
            if (_transfer == null) throw new ProtocolException("请先发送开始命令");
            if (!String.Equals(_transfer.SessionId, sessionId, StringComparison.Ordinal))
                throw new ProtocolException("数据写入来自其他蓝牙连接");
            if (_lastTransferActivity < DateTime.UtcNow - TransferIdleTimeout) throw new ProtocolException("打印资料接收超时，请重试");
            if (ordinal != _transfer.NextChunk) throw new ProtocolException("数据块重复或顺序错误");
            if (_transfer.Bytes.Count + payload.Length > _transfer.Length)
                throw new ProtocolException("打印资料超过声明的长度");
            _transfer.Bytes.AddRange(payload);
            _transfer.NextChunk++;
            _lastTransferActivity = DateTime.UtcNow;
            return false;
        }

        private Transfer Commit(string id, string sessionId)
        {
            lock (_gate)
            {
                if (_transfer == null) throw new ProtocolException("没有待提交的打印资料");
                if (!String.Equals(_transfer.SessionId, sessionId, StringComparison.Ordinal))
                    throw new ProtocolException("提交命令来自其他蓝牙连接");
                if (_transfer.Id != id) throw new ProtocolException("打印任务编号不匹配");
                if (_lastTransferActivity < DateTime.UtcNow - TransferIdleTimeout)
                {
                    FailTransferLocked(_transfer, "打印资料接收超时，可以重新发送");
                    throw new ProtocolException("打印资料接收超时，请重试");
                }
                var transfer = _transfer;
                if (transfer.Bytes.Count != transfer.Length) throw new ProtocolException("打印资料尚未接收完整");
                var bytes = transfer.Bytes.ToArray();
                var actual = HashHex(bytes);
                if (!String.Equals(actual, transfer.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    FailTransferLocked(transfer, "打印资料校验失败，请重新发送");
                    throw new ProtocolException("打印资料校验失败，请重新发送");
                }
                string envelopeJson;
                try
                {
                    envelopeJson = StrictUtf8.GetString(bytes);
                    RequireEnvelope(envelopeJson, transfer);
                }
                catch
                {
                    FailTransferLocked(transfer, "打印资料与开始命令不一致");
                    throw;
                }
                transfer.EnvelopeJson = envelopeJson;
                SetStatusLocked(transfer.Id, "uncertain", "正在确认本机接收结果，请勿重复发送");
                _jobStates[transfer.Id]["commitStarted"] = true;
                _transfer = null;
                return transfer;
            }
        }

        private void RequireEnvelope(string envelopeJson, Transfer transfer)
        {
            Dictionary<string, object> envelope;
            try { envelope = DeserializeObject(envelopeJson); }
            catch { throw new ProtocolException("打印资料不是有效 JSON"); }
            RequireKeys(envelope, "v", "job");
            if (Integer(envelope, "v") != 1) throw new ProtocolException("打印资料协议版本无效");
            if (!(envelope["job"] is Dictionary<string, object> job))
                throw new ProtocolException("打印资料任务格式无效");
            RequireKeys(job, "id", "document", "settings");
            if (!String.Equals(Text(job, "id"), transfer.Id, StringComparison.Ordinal))
                throw new ProtocolException("打印资料任务编号与开始命令不一致");
            if (!(job["settings"] is Dictionary<string, object> settings))
                throw new ProtocolException("打印资料设置格式无效");
            if (!String.Equals(Text(settings, "paper"), transfer.Paper, StringComparison.Ordinal))
                throw new ProtocolException("打印资料纸张与开始命令不一致");
        }

        private void FailTransferLocked(Transfer transfer, string message)
        {
            if (ReferenceEquals(_transfer, transfer)) _transfer = null;
            SetStatusLocked(transfer.Id, "failed", message);
        }

        private async Task SubmitAsync(Transfer transfer)
        {
            try
            {
                var status = await PostAsync("/v1/jobs", transfer.EnvelopeJson);
                RememberAndPublish(status);
                _ = Task.Run(() => WaitForTerminalAsync(Text(status, "id")));
            }
            catch (Exception error)
            {
                PublishFailure(transfer.Id, error, "打印电脑接收结果未确认",
                    sessionId: transfer.SessionId, submission: true);
            }
        }

        private async Task RefreshStatusAsync(string id, string sessionId = null)
        {
            try
            {
                var status = await GetAsync("/v1/jobs/" + Uri.EscapeDataString(id));
                RememberAndPublish(status);
            }
            catch (Exception error)
            {
                PublishFailure(id, error, "暂时无法查询原打印任务",
                    cacheUnknown: false, sessionId: sessionId);
            }
        }

        private async Task ResolveAsync(string id, string outcome)
        {
            try
            {
                var body = Json(new Dictionary<string, object> { ["outcome"] = outcome });
                var status = await PostAsync("/v1/jobs/" + Uri.EscapeDataString(id) + "/resolve", body);
                RememberAndPublish(status);
            }
            catch (Exception error)
            {
                PublishFailure(id, error, "核对结果尚未保存", cacheUnknown: false);
            }
        }

        private async Task WaitForTerminalAsync(string id)
        {
            var deadline = DateTime.UtcNow + JobWaitTimeout;
            while (!_stop.IsCancellationRequested && DateTime.UtcNow < deadline)
            {
                try
                {
                    var status = await GetAsync("/v1/jobs/" + Uri.EscapeDataString(id));
                    RememberAndPublish(status);
                    if (new[] { "queued", "failed", "uncertain" }.Contains(Text(status, "status"))) return;
                }
                catch (Exception error)
                {
                    PublishFailure(id, error, "打印状态查询中断");
                    return;
                }
                await Task.Delay(1000, _stop.Token);
            }
            UpdateStatus(id, "uncertain", "打印任务长时间未确认，请检查实际出纸，勿重复发送");
        }

        private void PublishFailure(
            string id,
            Exception error,
            string networkMessage,
            bool cacheUnknown = true,
            string sessionId = null,
            bool submission = false)
        {
            var http = error as RelayHttpException;
            lock (_gate)
            {
                _jobStates.TryGetValue(id, out var existing);
                var safelyRejected = http != null && http.SafeToRetry;
                var explicitSubmissionRejection = submission && safelyRejected && existing != null
                    && !Boolean(existing, "durable") && !existing.ContainsKey("confirmedPrintedAt")
                    && !new[] { "processing", "queued" }.Contains(Text(existing, "status"));
                if (http?.Code == "JOB_NOT_FOUND"
                    && !string.IsNullOrEmpty(sessionId)
                    && _transfer != null
                    && String.Equals(_transfer.Id, id, StringComparison.Ordinal)
                    && String.Equals(_transfer.SessionId, sessionId, StringComparison.Ordinal)
                    && _jobStates.TryGetValue(id, out var uncommitted)
                    && !Boolean(uncommitted, "durable")
                    && !Boolean(uncommitted, "commitStarted"))
                {
                    _transfer = null;
                    _jobStates.Remove(id);
                    _statusJson = StatusJson(id, "failed", "打印尚未提交到本机接收程序，可以重新发送",
                        Now(), "JOB_NOT_FOUND");
                }
                else if (existing != null && !explicitSubmissionRejection
                    && (IsDurableState(existing) || http?.Code == "JOB_NOT_FOUND"
                        || String.Equals(_transfer?.Id, id, StringComparison.Ordinal)
                        || Boolean(existing, "commitStarted")))
                {
                    if (http != null)
                        existing["code"] = http.Code == "JOB_NOT_FOUND" ? "RELAY_STATE_MISMATCH" : http.Code;
                    _statusJson = StatusJsonFromRowLocked(existing);
                }
                else
                {
                    var state = safelyRejected ? "failed" : "uncertain";
                    var message = http != null ? http.Message : networkMessage + "：" + error.Message;
                    UpdateStatus(id, state, message, code: http?.Code,
                        cache: cacheUnknown && http?.Code != "JOB_NOT_FOUND");
                    return;
                }
            }
            _ = NotifyStatusAsync();
        }

        private static bool IsDurableState(Dictionary<string, object> row)
        {
            return Boolean(row, "durable") || row.ContainsKey("confirmedPrintedAt")
                || new[] { "processing", "queued", "uncertain" }.Contains(Text(row, "status"));
        }

        private async Task<Dictionary<string, object>> PostAsync(string route, string body)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, _endpoint + route))
            {
                request.Headers.TryAddWithoutValidation("X-Warehouse-Ble-Relay", _capability);
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                using (var response = await _http.SendAsync(request, _stop.Token))
                    return ParseResponse(response);
            }
        }

        private async Task<Dictionary<string, object>> GetAsync(string route)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, _endpoint + route))
            {
                request.Headers.TryAddWithoutValidation("X-Warehouse-Ble-Relay", _capability);
                using (var response = await _http.SendAsync(request, _stop.Token))
                    return ParseResponse(response);
            }
        }

        private Dictionary<string, object> ParseResponse(HttpResponseMessage response)
        {
            var text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            var root = DeserializeObject(text);
            if (!response.IsSuccessStatusCode || !Boolean(root, "success"))
                throw new RelayHttpException(
                    (int)response.StatusCode,
                    Text(root, "code"),
                    Text(root, "message") ?? "本机接收程序返回失败",
                    Boolean(root, "safeToRetry"));
            return (Dictionary<string, object>)root["data"];
        }

        private void RememberAndPublish(Dictionary<string, object> status)
        {
            var id = Text(status, "id");
            if (string.IsNullOrEmpty(id)) throw new InvalidOperationException("打印状态缺少任务编号");
            lock (_gate)
            {
                if (!_jobStates.TryGetValue(id, out var row))
                    _jobStates[id] = row = new Dictionary<string, object>(StringComparer.Ordinal) { ["id"] = id };
                var stale = Boolean(row, "durable") && status.ContainsKey("updatedAt")
                    && row.ContainsKey("updatedAt")
                    && Convert.ToInt64(status["updatedAt"], CultureInfo.InvariantCulture)
                        < Convert.ToInt64(row["updatedAt"], CultureInfo.InvariantCulture);
                if (!stale) ApplyStatusLocked(row, Text(status, "status"), Text(status, "message"), status);
                row["durable"] = true;
                _statusJson = StatusJsonFromRowLocked(row);
                TrimJobStatesLocked();
            }
            _ = NotifyStatusAsync();
        }

        private void UpdateStatus(
            string id,
            string state,
            string message,
            Dictionary<string, object> source = null,
            string code = null,
            bool cache = true)
        {
            lock (_gate)
            {
                if (string.IsNullOrEmpty(id))
                {
                    _statusJson = StatusJson(string.Empty, state, message, Now(), code, null);
                }
                else if (cache || _jobStates.ContainsKey(id))
                {
                    if (!_jobStates.TryGetValue(id, out var row))
                        _jobStates[id] = row = new Dictionary<string, object>(StringComparer.Ordinal) { ["id"] = id };
                    ApplyStatusLocked(row, state, message, source);
                    if (!string.IsNullOrEmpty(code)) row["code"] = code;
                    _statusJson = StatusJsonFromRowLocked(row);
                    TrimJobStatesLocked();
                }
                else
                {
                    _statusJson = StatusJson(id, state, message, Now(), code, null);
                }
            }
            _ = NotifyStatusAsync();
        }

        private async Task NotifyStatusAsync()
        {
            try
            {
                string value;
                lock (_gate) value = _statusJson;
                if (_status != null)
                    await _status.NotifyValueAsync(Buffer(Encoding.UTF8.GetBytes(value))).AsTask();
            }
            catch
            {
                // A phone that disconnects mid-notification will recover by
                // reading the same durable status or sending an explicit status
                // command after reconnect.
            }
        }

        private static void SetStatusLocked(Dictionary<string, object> row, string state, string message)
        {
            ApplyStatusLocked(row, state, message, null);
        }

        private void SetStatusLocked(string id, string state, string message)
        {
            if (string.IsNullOrEmpty(id)) return;
            if (!_jobStates.TryGetValue(id, out var row))
                _jobStates[id] = row = new Dictionary<string, object>(StringComparer.Ordinal) { ["id"] = id };
            SetStatusLocked(row, state, message);
            _statusJson = StatusJsonFromRowLocked(row);
            TrimJobStatesLocked();
        }

        private static void ApplyStatusLocked(
            Dictionary<string, object> row,
            string state,
            string message,
            Dictionary<string, object> source)
        {
            row["status"] = string.IsNullOrEmpty(state) ? "uncertain" : state;
            row["message"] = string.IsNullOrEmpty(message) ? "打印状态未确认" : message;
            var updatedAt = source != null && source.ContainsKey("updatedAt")
                ? Convert.ToInt64(source["updatedAt"], CultureInfo.InvariantCulture)
                : Now();
            row["updatedAt"] = updatedAt;
            if (source != null && source.ContainsKey("code"))
                row["code"] = Convert.ToString(source["code"], CultureInfo.InvariantCulture);
            else
                row.Remove("code");
            if (source != null && source.ContainsKey("confirmedPrintedAt"))
                row["confirmedPrintedAt"] = Convert.ToInt64(source["confirmedPrintedAt"], CultureInfo.InvariantCulture);
        }

        private string StatusJsonFromRowLocked(Dictionary<string, object> row)
        {
            long? confirmed = row.ContainsKey("confirmedPrintedAt")
                ? Convert.ToInt64(row["confirmedPrintedAt"], CultureInfo.InvariantCulture)
                : (long?)null;
            return StatusJson(
                Text(row, "id"),
                Text(row, "status"),
                Text(row, "message"),
                Convert.ToInt64(row["updatedAt"], CultureInfo.InvariantCulture),
                Text(row, "code"),
                confirmed);
        }

        private string StatusJson(
            string id,
            string state,
            string message,
            long updatedAt,
            string code = null,
            long? confirmedPrintedAt = null)
        {
            var value = new Dictionary<string, object>
            {
                ["v"] = 1,
                ["id"] = ValidId(id) ? id : string.Empty,
                ["status"] = new[] { "received", "processing", "queued", "failed", "uncertain" }.Contains(state) ? state : "uncertain",
                ["message"] = string.Empty,
                ["updatedAt"] = updatedAt,
            };
            if (!string.IsNullOrEmpty(code) && code.Length <= 64
                && code.All(character => (character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9') || character == '_'))
                value["code"] = code;
            if (confirmedPrintedAt.HasValue) value["confirmedPrintedAt"] = confirmedPrintedAt.Value;
            message = message ?? "打印状态未确认";
            var left = 0;
            var right = Math.Min(message.Length, 4096);
            string result = Json(value);
            while (left <= right)
            {
                var length = left + (right - left) / 2;
                var prefixLength = length;
                if (prefixLength > 0 && prefixLength < message.Length
                    && Char.IsHighSurrogate(message[prefixLength - 1]) && Char.IsLowSurrogate(message[prefixLength]))
                    prefixLength--;
                value["message"] = message.Substring(0, prefixLength);
                var candidate = Json(value);
                if (Encoding.UTF8.GetByteCount(candidate) <= MaxStatusBytes)
                {
                    result = candidate;
                    left = length + 1;
                }
                else right = length - 1;
            }
            if (Encoding.UTF8.GetByteCount(result) > MaxStatusBytes)
                throw new InvalidOperationException("打印状态超过蓝牙读取上限");
            return result;
        }

        private void TrimJobStatesLocked()
        {
            if (_jobStates.Count <= MaxJobStates) return;
            var activeTransferId = _transfer?.Id;
            foreach (var id in _jobStates.Keys
                .Where(id => !String.Equals(id, activeTransferId, StringComparison.Ordinal))
                .OrderBy(id => new[] { "queued", "failed" }.Contains(Text(_jobStates[id], "status")) ? 0 : 1)
                .ThenBy(id => Convert.ToInt64(_jobStates[id]["updatedAt"], CultureInfo.InvariantCulture))
                .Take(_jobStates.Count - MaxJobStates)
                .ToArray())
                _jobStates.Remove(id);
        }

        private static long Now()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        private async Task WatchParentAsync()
        {
            if (_parentPid <= 0) return;
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    using (System.Diagnostics.Process.GetProcessById(_parentPid)) { }
                }
                catch
                {
                    _stop.Cancel();
                    return;
                }
                await Task.Delay(2000, _stop.Token);
            }
        }

        private async Task ExpireTransfersAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                await Task.Delay(5000, _stop.Token);
                var expired = false;
                lock (_gate)
                {
                    ExpireControlAssembliesLocked(DateTime.UtcNow);
                    if (_transfer != null && _lastTransferActivity < DateTime.UtcNow - TransferIdleTimeout)
                    {
                        var id = _transfer.Id;
                        _transfer = null;
                        SetStatusLocked(id, "failed", "打印资料接收超时，可以重新发送");
                        expired = true;
                    }
                }
                if (expired) _ = NotifyStatusAsync();
            }
        }

        private void WaitForStop()
        {
            using (var exit = new ManualResetEventSlim())
            {
                Console.CancelKeyPress += (sender, args) => { args.Cancel = true; exit.Set(); };
                AppDomain.CurrentDomain.ProcessExit += (sender, args) => exit.Set();
                using (_stop.Token.Register(() => exit.Set()))
                    exit.Wait();
            }
        }

        private void DetachHandlers()
        {
            try { if (_control != null) _control.WriteRequested -= OnControlWrite; } catch { }
            try { if (_data != null) _data.WriteRequested -= OnDataWrite; } catch { }
            try { if (_status != null) _status.ReadRequested -= OnStatusRead; } catch { }
        }

        private string Json(object value)
        {
            lock (_jsonGate) return _json.Serialize(value);
        }

        private Dictionary<string, object> DeserializeObject(string value)
        {
            lock (_jsonGate) return (Dictionary<string, object>)_json.DeserializeObject(value);
        }

        private static IBuffer Buffer(byte[] bytes)
        {
            return CryptographicBuffer.CreateFromByteArray(bytes);
        }

        private static string SessionId(GattWriteRequestedEventArgs args)
        {
            var id = args.Session?.DeviceId?.Id;
            if (string.IsNullOrEmpty(id)) throw new ProtocolException("无法确认蓝牙连接会话");
            return id;
        }

        private static string SessionId(GattReadRequestedEventArgs args)
        {
            var id = args.Session?.DeviceId?.Id;
            if (string.IsNullOrEmpty(id)) throw new ProtocolException("无法确认蓝牙连接会话");
            return id;
        }

        private static void Respond(GattWriteRequest request)
        {
            try
            {
                if (request != null && request.Option == GattWriteOption.WriteWithResponse
                    && request.State == GattRequestState.Pending)
                    request.Respond();
            }
            catch { }
        }

        private static void RespondWithError(GattWriteRequest request, byte error)
        {
            try
            {
                if (request != null && request.Option == GattWriteOption.WriteWithResponse
                    && request.State == GattRequestState.Pending)
                    request.RespondWithProtocolError(error);
            }
            catch { }
        }

        private static byte[] BufferBytes(IBuffer buffer)
        {
            using (var reader = DataReader.FromBuffer(buffer))
            {
                var bytes = new byte[reader.UnconsumedBufferLength];
                reader.ReadBytes(bytes);
                return bytes;
            }
        }

        private static string HashHex(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                var digest = sha.ComputeHash(bytes);
                var text = new StringBuilder(digest.Length * 2);
                foreach (var value in digest) text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static bool IsSha256(string value)
        {
            return !string.IsNullOrEmpty(value) && value.Length == 64
                && value.All(character =>
                    (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));
        }

        private static bool ValidId(string value)
        {
            return !string.IsNullOrEmpty(value) && value.Length >= 16 && value.Length <= 100
                && value.All(character =>
                    (character >= 'a' && character <= 'z') ||
                    (character >= 'A' && character <= 'Z') ||
                    (character >= '0' && character <= '9') ||
                    character == '-');
        }

        private static void RequireKeys(Dictionary<string, object> input, params string[] keys)
        {
            if (input == null || input.Count != keys.Length || keys.Any(key => !input.ContainsKey(key)))
                throw new ProtocolException("控制命令包含不支持或缺失的字段");
        }

        private static string Text(Dictionary<string, object> input, string key)
        {
            if (input == null || !input.TryGetValue(key, out var value)) return null;
            return value as string;
        }

        private static long Integer(Dictionary<string, object> input, string key)
        {
            if (input == null || !input.TryGetValue(key, out var value)) throw new ProtocolException("缺少数值字段");
            if (!(value is byte || value is sbyte || value is short || value is ushort
                || value is int || value is uint || value is long || value is ulong))
                throw new ProtocolException("数值字段必须为整数");
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch { throw new ProtocolException("数值字段无效"); }
        }

        private static bool Boolean(Dictionary<string, object> input, string key)
        {
            return input != null && input.TryGetValue(key, out var value) && value is bool boolean && boolean;
        }

        private sealed class ControlAssembly
        {
            internal ControlAssembly(int length, DateTime updatedAt)
            {
                Bytes = new byte[length];
                UpdatedAt = updatedAt;
            }

            public byte[] Bytes { get; }
            public int NextOffset { get; set; }
            public DateTime UpdatedAt { get; set; }
        }

        private sealed class StatusReadSnapshot
        {
            public byte[] Bytes { get; set; }
            public DateTime UpdatedAt { get; set; }
        }

        private sealed class Transfer
        {
            public string Id { get; set; }
            public int Length { get; set; }
            public string Sha256 { get; set; }
            public string Paper { get; set; }
            public string SessionId { get; set; }
            public DateTime StartedAt { get; set; }
            public uint NextChunk { get; set; }
            public List<byte> Bytes { get; } = new List<byte>();
            public string EnvelopeJson { get; set; }
        }

        private sealed class ProtocolException : Exception
        {
            public ProtocolException(string message, byte attError = 0x80) : base(message)
            {
                AttError = attError;
            }

            public byte AttError { get; }
        }

        private sealed class RelayHttpException : Exception
        {
            internal RelayHttpException(int statusCode, string code, string message, bool safeToRetry)
                : base(message)
            {
                StatusCode = statusCode;
                Code = code;
                SafeToRetry = safeToRetry;
            }

            public int StatusCode { get; }
            public string Code { get; }
            public bool SafeToRetry { get; }
        }
    }
}
