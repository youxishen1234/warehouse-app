using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class ProtocolTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly List<object> Hosts = new List<object>();
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static Type HostType;
    private static int Passed;
    private const string JobId = "remote-windows-protocol-0001";
    private const string OtherId = "remote-windows-protocol-0002";
    private const string Paper = "241-93";
    private const BindingFlags Hidden = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static;

    private static int Main(string[] args)
    {
        var oldApi = Environment.GetEnvironmentVariable("WAREHOUSE_BLE_API");
        var oldToken = Environment.GetEnvironmentVariable("WAREHOUSE_BLE_TOKEN");
        Environment.SetEnvironmentVariable("WAREHOUSE_BLE_API", "http://127.0.0.1:1");
        Environment.SetEnvironmentVariable("WAREHOUSE_BLE_TOKEN", new string('t', 64));
        try
        {
            HostType = Assembly.LoadFrom(args[0]).GetType("Warehouse.Ble630KRelay.RelayHost", true);
            Test("stable relay identifier is a canonical UUID version 5", RelayIdentifier);
            Test("MTU 23 control frames reassemble UTF-8 and support raw JSON", ControlFrames);
            Test("control frames reject malformed lengths, offsets and session mixing", InvalidFrames);
            Test("control assemblies have expiry and a bounded capacity", ControlBounds);
            Test("begin and data are bound to one session without overwriting active jobs", SessionOwnership);
            Test("commit validates envelope id, paper, UTF-8, length and hash", CommitValidation);
            Test("expired or corrupt transfers are released without forwarding", TransferExpiry);
            Test("status is bounded valid UTF-8 JSON and long reads use byte offsets", StatusReads);
            Test("long-read snapshots remain coherent and bounded per session", ReadSnapshots);
            Test("status keeps confirmation, clears stale codes and preserves durable states", DurableStatuses);
            Test("HTTP not-found is explicit and uncached; network errors remain uncertain", FailureClassification);
            Test("HTTP error metadata is retained and success is parsed", HttpMetadata);
            Test("commit receipt awaits journal response before returning", SubmitReceiptGate);
            Test("submission failures require explicit safe rejection to become retryable", SubmissionFailures);
            Test("status and resolve await local HTTP before completing", QueryReceiptGate);
            Test("transfer-only not-found release requires matching session and pre-commit state", PrecommitRecovery);
            Test("job-state cache is bounded and terminal rows are evicted first", CacheBounds);
            Test("shared serializer is synchronized for concurrent round trips", ConcurrentSerializer);
            Test("numeric and null write-response helpers reject unsafe coercions", PrimitiveValidation);
            Console.WriteLine("PASS " + Passed + " Windows BLE protocol tests (no radio or printer used)");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            foreach (var host in Hosts)
            {
                ((CancellationTokenSource)Field(host, "_stop")).Cancel();
                ((HttpClient)Field(host, "_http")).Dispose();
            }
            Environment.SetEnvironmentVariable("WAREHOUSE_BLE_API", oldApi);
            Environment.SetEnvironmentVariable("WAREHOUSE_BLE_TOKEN", oldToken);
        }
    }

    private static void Test(string name, Action run)
    {
        run();
        Passed++;
        Console.WriteLine("PASS " + name);
    }

    private static object Host()
    {
        var host = Activator.CreateInstance(HostType, true);
        Hosts.Add(host);
        return host;
    }

    private static object Call(object host, string name, params object[] args)
    {
        try
        {
            var method = HostType.GetMethods(Hidden).Single(candidate => candidate.Name == name
                && candidate.GetParameters().Length >= args.Length
                && candidate.GetParameters().Skip(args.Length).All(parameter => parameter.IsOptional));
            var parameters = method.GetParameters();
            var fullArgs = args.Concat(parameters.Skip(args.Length).Select(parameter => parameter.DefaultValue)).ToArray();
            return method.Invoke(host, fullArgs);
        }
        catch (TargetInvocationException error)
        {
            ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }
    }

    private static object Field(object host, string name)
    {
        return HostType.GetField(name, Hidden).GetValue(host);
    }

    private static void SetField(object host, string name, object value)
    {
        HostType.GetField(name, Hidden).SetValue(host, value);
    }

    private static Dictionary<string, Dictionary<string, object>> Rows(object host)
    {
        return (Dictionary<string, Dictionary<string, object>>)Field(host, "_jobStates");
    }

    private static Dictionary<string, object> Status(object host)
    {
        return Json.Deserialize<Dictionary<string, object>>((string)Field(host, "_statusJson"));
    }

    private static void Check(bool value, string message)
    {
        if (!value) throw new Exception(message);
    }

    private static Exception Reject(Action action, byte attError = 0x80)
    {
        try { action(); }
        catch (Exception error)
        {
            Check(error.GetType().Name == "ProtocolException", "Expected ProtocolException, got " + error);
            Check((byte)error.GetType().GetProperty("AttError").GetValue(error) == attError, "Unexpected ATT error");
            return error;
        }
        throw new Exception("Expected protocol rejection");
    }

    private static byte[] Frame(int commandId, int total, int offset, byte[] payload)
    {
        var result = new byte[9 + payload.Length];
        result[0] = 0xb6;
        result[1] = (byte)(commandId >> 8); result[2] = (byte)commandId;
        result[3] = (byte)(total >> 8); result[4] = (byte)total;
        result[5] = (byte)(offset >> 8); result[6] = (byte)offset;
        result[7] = (byte)(payload.Length >> 8); result[8] = (byte)payload.Length;
        Array.Copy(payload, 0, result, 9, payload.Length);
        return result;
    }

    private static void ControlFrames()
    {
        var host = Host();
        var bytes = Utf8.GetBytes("{\"v\":1,\"op\":\"begin\",\"message\":\"中文\"}");
        for (var offset = 0; offset < bytes.Length; offset += 11)
        {
            var part = bytes.Skip(offset).Take(11).ToArray();
            var frame = Frame(65535, bytes.Length, offset, part);
            Check(frame.Length <= 20, "Frame exceeded MTU 23 write payload");
            var complete = (byte[])Call(host, "AcceptControlFrame", "session-a", frame);
            Check(offset + part.Length == bytes.Length ? complete.SequenceEqual(bytes) : complete == null, "Incorrect assembly result");
        }
        Check(((IDictionary)Field(host, "_controlAssemblies")).Count == 0, "Completed assembly retained");
        Check(((byte[])Call(host, "AcceptControlFrame", "session-a", bytes)).SequenceEqual(bytes), "Raw JSON compatibility failed");
        var maximum = Enumerable.Repeat((byte)'x', 4096).ToArray();
        Check(((byte[])Call(host, "AcceptControlFrame", "session-a", Frame(0, 4096, 0, maximum))).Length == 4096, "4096-byte command rejected");
    }

    private static void RelayIdentifier()
    {
        var program = HostType.Assembly.GetType("Warehouse.Ble630KRelay.Program", true);
        var id = (Guid)program.GetMethod("RelayId", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
        var text = id.ToString();
        Check(text[14] == '5', "Relay UUID is not version 5: " + text);
        var variant = Convert.ToInt32(text[19].ToString(), 16);
        Check((variant & 0x8) != 0 && (variant & 0x4) == 0, "Relay UUID has an invalid variant: " + text);
        Check(text == id.ToString(), "Relay UUID is not stable for this process");
    }

    private static void InvalidFrames()
    {
        var host = Host();
        Reject(() => Call(host, "AcceptControlFrame", "", new byte[] { 1 }));
        Reject(() => Call(host, "AcceptControlFrame", "a", new byte[0]));
        Reject(() => Call(host, "AcceptControlFrame", "a", new byte[] { 0xb6 }));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 4097, 0, new byte[] { 1 })));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 1, 0, new byte[0])));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 2, 1, new byte[] { 1, 2 })));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 2, 1, new byte[] { 1 })));
        Call(host, "AcceptControlFrame", "a", Frame(1, 3, 0, new byte[] { 1 }));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 3, 0, new byte[] { 1 })));
        Call(host, "AcceptControlFrame", "a", Frame(1, 3, 0, new byte[] { 1 }));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(1, 4, 1, new byte[] { 2 })));
        Call(host, "AcceptControlFrame", "a", Frame(1, 3, 0, new byte[] { 1 }));
        Reject(() => Call(host, "AcceptControlFrame", "b", Frame(1, 3, 1, new byte[] { 2 })));
        Check(((byte[])Call(host, "AcceptControlFrame", "a", Frame(1, 3, 1, new byte[] { 2, 3 }))).SequenceEqual(new byte[] { 1, 2, 3 }), "Other session damaged assembly");
        var wrongLength = Frame(2, 2, 0, new byte[] { 1 });
        wrongLength[8] = 2;
        Reject(() => Call(host, "AcceptControlFrame", "a", wrongLength));
        Reject(() => Call(host, "AcceptControlFrame", "a", Enumerable.Repeat((byte)'x', 4097).ToArray()));
    }

    private static void ControlBounds()
    {
        var host = Host();
        for (var index = 0; index < 16; index++)
            Call(host, "AcceptControlFrame", "a", Frame(index, 2, 0, new byte[] { 1 }));
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(16, 2, 0, new byte[] { 1 })));
        var assemblies = (IDictionary)Field(host, "_controlAssemblies");
        foreach (var assembly in assemblies.Values)
            assembly.GetType().GetProperty("UpdatedAt").SetValue(assembly, DateTime.UtcNow.AddMinutes(-1));
        Call(host, "AcceptControlFrame", "a", Frame(16, 2, 0, new byte[] { 1 }));
        Check(assemblies.Count == 1, "Expired assemblies were not removed");
        Reject(() => Call(host, "AcceptControlFrame", "a", Frame(0, 2, 1, new byte[] { 2 })));
    }

    private static byte[] Envelope(string id = JobId, string paper = Paper)
    {
        return Utf8.GetBytes(Json.Serialize(new { v = 1, job = new { id, document = new { title = "中文" }, settings = new { paper } } }));
    }

    private static string Hash(byte[] bytes)
    {
        using (var sha = SHA256.Create())
            return string.Concat(sha.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
    }

    private static void Begin(object host, byte[] bytes, string id = JobId, string session = "session-a", string hash = null)
    {
        Call(host, "Begin", id, (long)bytes.Length, hash ?? Hash(bytes), Paper, session);
    }

    private static void Append(object host, byte[] bytes, string session = "session-a")
    {
        for (var offset = 0; offset < bytes.Length; offset += 16)
            Call(host, "AppendChunk", session, (uint)(offset / 16), bytes.Skip(offset).Take(16).ToArray());
    }

    private static void SessionOwnership()
    {
        var host = Host();
        var bytes = Envelope();
        Begin(host, bytes);
        var transfer = Field(host, "_transfer");
        Reject(() => Begin(host, bytes, OtherId, "session-b"));
        Check(ReferenceEquals(transfer, Field(host, "_transfer")), "Other begin overwrote transfer");
        Reject(() => Call(host, "AppendChunk", "session-b", (uint)0, new byte[] { 1 }));
        Reject(() => Call(host, "Commit", JobId, "session-b"));
        Call(host, "PublishProtocolFailure", JobId, "bad frame");
        Check((string)Rows(host)[JobId]["status"] == "received", "Protocol error downgraded active transfer");
        Append(host, bytes);
        Reject(() => Call(host, "AppendChunk", "session-a", (uint)0, new byte[] { 1 }));
        var committed = Call(host, "Commit", JobId, "session-a");
        Check(Field(host, "_transfer") == null && committed.GetType().GetProperty("EnvelopeJson").GetValue(committed) != null, "Valid commit failed");
        Remember(host, JobId, "queued");
        Reject(() => Begin(host, bytes));
        Call(host, "PublishProtocolFailure", JobId, "duplicate begin");
        Check((string)Rows(host)[JobId]["status"] == "queued", "Duplicate begin downgraded queued job");
    }

    private static void CommitValidation()
    {
        foreach (var bytes in new[] { Envelope(OtherId), Envelope(JobId, "a4"), Utf8.GetBytes("not-json"), new byte[] { 0xff, 0xfe } })
        {
            var host = Host();
            Begin(host, bytes); Append(host, bytes);
            try { Call(host, "Commit", JobId, "session-a"); throw new Exception("Invalid envelope accepted"); }
            catch (Exception error) { Check(error.GetType().Name == "ProtocolException" || error is DecoderFallbackException, "Unexpected envelope error"); }
            Check(Field(host, "_transfer") == null && (string)Rows(host)[JobId]["status"] == "failed", "Invalid complete transfer was retained");
        }
        var partialHost = Host();
        var valid = Envelope();
        Begin(partialHost, valid);
        Reject(() => Call(partialHost, "Commit", JobId, "session-a"));
        Check(Field(partialHost, "_transfer") != null, "Incomplete transfer should remain resumable");
        Append(partialHost, valid);
        Reject(() => Call(partialHost, "Commit", OtherId, "session-a"));
        Check(Field(partialHost, "_transfer") != null, "Wrong id cleared another transfer");
    }

    private static void TransferExpiry()
    {
        var bytes = Envelope();
        var hashHost = Host();
        Begin(hashHost, bytes, hash: new string('0', 64)); Append(hashHost, bytes);
        Reject(() => Call(hashHost, "Commit", JobId, "session-a"));
        Check(Field(hashHost, "_transfer") == null, "Bad hash transfer retained");
        var expired = Host();
        Begin(expired, bytes); Append(expired, bytes);
        SetField(expired, "_lastTransferActivity", DateTime.UtcNow.AddMinutes(-3));
        Reject(() => Call(expired, "Commit", JobId, "session-a"));
        Check(Field(expired, "_transfer") == null, "Expired commit retained transfer");
        var replace = Host();
        Begin(replace, bytes);
        SetField(replace, "_lastTransferActivity", DateTime.UtcNow.AddMinutes(-3));
        Begin(replace, Envelope(OtherId), OtherId, "session-b");
        Check((string)Rows(replace)[JobId]["status"] == "failed", "Expired begin not marked failed");
    }

    private static void Update(object host, string id, string state, string message, string code = null, bool cache = true)
    {
        Call(host, "UpdateStatus", id, state, message, null, code, cache);
    }

    private static byte[] Read(object host, uint offset = 0, string session = "read-a")
    {
        return (byte[])Call(host, "ReadStatusValue", offset, session);
    }

    private static void StatusReads()
    {
        var host = Host();
        var message = string.Concat(Enumerable.Repeat("中文\"\\\n\U0001f600", 600));
        Update(host, new string('x', 100), "uncertain", message, "RELAY_STATE_MISMATCH");
        var bytes = Read(host);
        Check(bytes.Length <= 512, "Status exceeded ATT maximum attribute value");
        var decoded = Json.Deserialize<Dictionary<string, object>>(Utf8.GetString(bytes));
        Check(((string)decoded["message"]).Length > 0, "Status discarded all readable message text");
        Check(Read(host, 7).SequenceEqual(bytes.Skip(7)), "Read did not honor byte offset");
        Check(Read(host, (uint)bytes.Length).Length == 0, "Exact end read must return empty");
        Reject(() => Read(host, (uint)bytes.Length + 1), 0x07);
    }

    private static void ReadSnapshots()
    {
        var host = Host();
        Update(host, JobId, "received", "初始中文状态");
        var first = Read(host);
        Update(host, JobId, "queued", "新状态");
        Check(Read(host, 5).SequenceEqual(first.Skip(5)), "Long read mixed status versions");
        Check(!Read(host).SequenceEqual(first), "Offset zero did not refresh snapshot");
        for (var index = 0; index < 30; index++) Read(host, 0, "session-" + index);
        Check(((IDictionary)Field(host, "_statusReadSnapshots")).Count <= 16, "Read snapshots unbounded");
    }

    private static Dictionary<string, object> PublicStatus(string id, string state, bool confirmation = false)
    {
        var result = new Dictionary<string, object> { ["v"] = 1, ["id"] = id, ["status"] = state, ["message"] = "状态", ["updatedAt"] = 1790000000000L };
        if (confirmation) result["confirmedPrintedAt"] = 1790000000001L;
        return result;
    }

    private static void Remember(object host, string id, string state, bool confirmation = false)
    {
        Call(host, "RememberAndPublish", PublicStatus(id, state, confirmation));
    }

    private static Exception HttpError(int status, string code, bool retry)
    {
        var type = HostType.GetNestedType("RelayHttpException", BindingFlags.NonPublic);
        return (Exception)Activator.CreateInstance(type, Hidden, null, new object[] { status, code, "本机接收失败", retry }, CultureInfo.InvariantCulture);
    }

    private static void Fail(object host, string id, Exception error, bool cache = true)
    {
        Call(host, "PublishFailure", id, error, "连接中断", cache, null);
    }

    private static void DurableStatuses()
    {
        foreach (var state in new[] { "received", "processing", "queued", "uncertain", "failed" })
        {
            var host = Host();
            Remember(host, JobId, state, true);
            Fail(host, JobId, HttpError(404, "JOB_NOT_FOUND", true), false);
            var status = Status(host);
            Check((string)status["status"] == state && (string)status["code"] == "RELAY_STATE_MISMATCH", "Known job changed state on not found");
            Check(Convert.ToInt64(status["confirmedPrintedAt"]) == 1790000000001L, "Lost physical confirmation");
            Fail(host, JobId, new HttpRequestException("socket closed"), false);
            Check((string)Status(host)["status"] == state, "Network error downgraded known job");
            Remember(host, JobId, state);
            Check(!Status(host).ContainsKey("code") && Status(host).ContainsKey("confirmedPrintedAt"), "Authoritative update kept stale code or lost confirmation");
            var stale = PublicStatus(JobId, "processing");
            stale["updatedAt"] = 1780000000000L;
            Call(host, "RememberAndPublish", stale);
            Check((string)Status(host)["status"] == state, "Older HTTP response overwrote current state");
        }
    }

    private static void FailureClassification()
    {
        var host = Host();
        Fail(host, JobId, HttpError(404, "JOB_NOT_FOUND", true), false);
        Check((string)Status(host)["status"] == "failed" && (string)Status(host)["code"] == "JOB_NOT_FOUND", "Unknown job not explicit");
        Check(Rows(host).Count == 0, "Unknown status query polluted cache");
        Fail(host, OtherId, new HttpRequestException("offline"), false);
        Check((string)Status(host)["status"] == "uncertain" && !Status(host).ContainsKey("code"), "Offline query inferred missing");
        Fail(host, JobId, HttpError(503, "JOURNAL_UNAVAILABLE", false));
        Check((string)Status(host)["status"] == "uncertain", "Unsafe HTTP failure marked retryable");
        var rejected = Host();
        Fail(rejected, JobId, HttpError(400, "INVALID_JOB", true));
        Check((string)Status(rejected)["status"] == "failed", "Explicit safe rejection not reported");
        var receiving = Host();
        Begin(receiving, Envelope());
        Fail(receiving, JobId, HttpError(404, "JOB_NOT_FOUND", true), false);
        Check((string)Rows(receiving)[JobId]["status"] == "received" && (string)Status(receiving)["code"] == "RELAY_STATE_MISMATCH", "Status query downgraded current transfer");
    }

    private static HttpResponseMessage Response(HttpStatusCode code, object body)
    {
        return new HttpResponseMessage(code) { Content = new StringContent(Json.Serialize(body), Encoding.UTF8, "application/json") };
    }

    private static void HttpMetadata()
    {
        var host = Host();
        using (var response = Response(HttpStatusCode.NotFound, new { success = false, code = "JOB_NOT_FOUND", message = "不存在", safeToRetry = true }))
        {
            try { Call(host, "ParseResponse", response); throw new Exception("HTTP failure accepted"); }
            catch (Exception error)
            {
                Check(error.GetType().Name == "RelayHttpException", "HTTP failure type not preserved");
                Check((string)error.GetType().GetProperty("Code").GetValue(error) == "JOB_NOT_FOUND", "HTTP code lost");
                Check((bool)error.GetType().GetProperty("SafeToRetry").GetValue(error), "HTTP retry flag lost");
            }
        }
        using (var response = Response(HttpStatusCode.OK, new { success = true, data = PublicStatus(JobId, "queued") }))
            Check((string)((Dictionary<string, object>)Call(host, "ParseResponse", response))["status"] == "queued", "HTTP success failed");
    }

    private sealed class HeldHandler : HttpMessageHandler
    {
        internal readonly TaskCompletionSource<HttpResponseMessage> Held = new TaskCompletionSource<HttpResponseMessage>();
        internal int Requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (Interlocked.Increment(ref Requests) == 1) return Held.Task;
            return Task.FromResult(Response(HttpStatusCode.OK, new { success = true, data = PublicStatus(JobId, "queued") }));
        }
    }

    private static HeldHandler HoldHttp(object host)
    {
        ((HttpClient)Field(host, "_http")).Dispose();
        var handler = new HeldHandler();
        SetField(host, "_http", new HttpClient(handler));
        return handler;
    }

    private static void SubmitReceiptGate()
    {
        var host = Host();
        var bytes = Envelope();
        Begin(host, bytes); Append(host, bytes);
        var transfer = Call(host, "Commit", JobId, "session-a");
        var handler = HoldHttp(host);
        var task = (Task)Call(host, "SubmitAsync", transfer);
        Check(!task.IsCompleted && !(bool)Rows(host)[JobId]["durable"], "Submit completed before journal response");
        handler.Held.SetResult(Response(HttpStatusCode.Accepted, new { success = true, data = PublicStatus(JobId, "queued") }));
        Check(task.Wait(3000), "Submit did not complete after receipt");
        Check((bool)Rows(host)[JobId]["durable"] && (string)Status(host)["status"] == "queued", "Receipt state not published before completion");
    }

    private static void QueryReceiptGate()
    {
        foreach (var resolve in new[] { false, true })
        {
            var host = Host();
            var handler = HoldHttp(host);
            var task = resolve ? (Task)Call(host, "ResolveAsync", JobId, "printed") : (Task)Call(host, "RefreshStatusAsync", JobId, "session-a");
            Check(!task.IsCompleted, "Command completed before HTTP response");
            handler.Held.SetResult(Response(HttpStatusCode.OK, new { success = true, data = PublicStatus(JobId, "queued", true) }));
            Check(task.Wait(3000) && Status(host).ContainsKey("confirmedPrintedAt"), "Command returned before confirmed status");
        }
    }

    private static void SubmissionFailures()
    {
        foreach (var safe in new[] { false, true })
        {
            var host = Host();
            var bytes = Envelope();
            Begin(host, bytes); Append(host, bytes);
            var transfer = Call(host, "Commit", JobId, "session-a");
            Check((bool)Rows(host)[JobId]["commitStarted"] && (string)Status(host)["status"] == "uncertain",
                "Commit did not establish the ambiguity boundary before HTTP");
            var handler = HoldHttp(host);
            var task = (Task)Call(host, "SubmitAsync", transfer);
            handler.Held.SetResult(Response(safe ? HttpStatusCode.BadRequest : HttpStatusCode.ServiceUnavailable,
                new { success = false, code = safe ? "INVALID_JOB" : "JOURNAL_UNAVAILABLE", message = "rejected", safeToRetry = safe }));
            Check(task.Wait(3000), "Submission failure did not finish");
            Check((string)Status(host)["status"] == (safe ? "failed" : "uncertain"),
                "Submission failure crossed the retry boundary incorrectly");
            if (safe)
            {
                Begin(host, bytes);
                Check(!(bool)Rows(host)[JobId]["commitStarted"], "A safe retry retained the prior commit marker");
            }
        }
        var disconnected = Host();
        var envelope = Envelope();
        Begin(disconnected, envelope); Append(disconnected, envelope);
        var committed = Call(disconnected, "Commit", JobId, "session-a");
        var transport = HoldHttp(disconnected);
        var pending = (Task)Call(disconnected, "SubmitAsync", committed);
        transport.Held.SetException(new HttpRequestException("connection dropped"));
        Check(pending.Wait(3000) && (string)Status(disconnected)["status"] == "uncertain",
            "Transport failure falsely established non-receipt");
    }

    private static void PrecommitRecovery()
    {
        var host = Host();
        var bytes = Envelope();
        Begin(host, bytes);
        Fail(host, JobId, HttpError(404, "JOB_NOT_FOUND", true), false);
        Check(Field(host, "_transfer") != null && (string)Rows(host)[JobId]["status"] == "received",
            "Not-found without a matching status session released transfer");
        Call(host, "PublishFailure", JobId, HttpError(404, "JOB_NOT_FOUND", true), "x", false, "session-b");
        Check(Field(host, "_transfer") != null, "Other session released transfer");
        var handler = HoldHttp(host);
        var query = (Task)Call(host, "RefreshStatusAsync", JobId, "session-a");
        handler.Held.SetResult(Response(HttpStatusCode.NotFound,
            new { success = false, code = "JOB_NOT_FOUND", message = "missing", safeToRetry = true }));
        Check(query.Wait(3000), "Pre-commit status query did not finish");
        Check(Field(host, "_transfer") == null && (string)Status(host)["status"] == "failed"
            && (string)Status(host)["code"] == "JOB_NOT_FOUND",
            "Matching pre-commit not-found did not release an abandoned transfer");
        Check(!Rows(host).ContainsKey(JobId), "Pre-commit not-found polluted the cache");

        var committed = Host();
        Begin(committed, bytes); Append(committed, bytes);
        Call(committed, "Commit", JobId, "session-a");
        Fail(committed, JobId, HttpError(404, "JOB_NOT_FOUND", true), false);
        Check((string)Status(committed)["code"] == "RELAY_STATE_MISMATCH",
            "Committed transfer became retryable after not-found");
    }

    private static void CacheBounds()
    {
        var host = Host();
        Remember(host, JobId, "uncertain");
        for (var index = 0; index < 400; index++) Remember(host, "remote-cache-test-" + index.ToString("d4"), "queued");
        Check(Rows(host).Count <= 256 && Rows(host).ContainsKey(JobId), "Cache not bounded or inflight evicted before terminal rows");
        var active = Host();
        Begin(active, Envelope());
        for (var index = 0; index < 400; index++) Remember(active, "remote-active-test-" + index.ToString("d4"), "uncertain");
        Check(Rows(active).Count <= 256 && Rows(active).ContainsKey(JobId), "Active transfer was evicted");
    }

    private static void ConcurrentSerializer()
    {
        var host = Host();
        Parallel.For(0, 1000, index =>
        {
            var value = new Dictionary<string, object> { ["id"] = "job-" + index, ["message"] = "并发中文" };
            var text = (string)Call(host, "Json", value);
            var result = (Dictionary<string, object>)Call(host, "DeserializeObject", text);
            Check((string)result["id"] == "job-" + index, "Serializer corrupted concurrent data");
        });
    }

    private static void PrimitiveValidation()
    {
        foreach (var value in new object[] { true, "1", 1.5, null })
            Reject(() => Call(null, "Integer", new Dictionary<string, object> { ["v"] = value }, "v"));
        Check((long)Call(null, "Integer", new Dictionary<string, object> { ["v"] = 1 }, "v") == 1, "Integer rejected valid number");
        Call(null, "Respond", new object[] { null });
        Call(null, "RespondWithError", null, (byte)0x80);
    }
}
