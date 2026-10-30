/* eslint-disable react/forbid-elements */
import { useEffect } from 'react';
import RemotePrint, { useRemotePrint } from './remote';
import styles from './index.module.scss';
import connectionStyles from './connection.module.scss';

export default function PrintConnection({ onPairChange }: { onPairChange: () => void }) {
  const remote = useRemotePrint(undefined, '241-93');
  const ready = !!remote.device?.online && !!remote.device?.ready && !remote.deviceError;

  useEffect(() => { onPairChange(); }, [remote.token, onPairChange]);

  return <section aria-label='连接打印电脑' className={`${styles.demoConnection} ${ready ? styles.demoConnected : ''}`}>
    <div className={connectionStyles.header}>
      <span className={styles.printerState} role='status'><i aria-hidden='true' />{remote.deviceStatus}</span>
      <button type='button' className={styles.secondary} disabled={remote.busy}
        onClick={() => remote.token ? remote.requestRefresh() : void remote.pair()}>
        {remote.busy ? '正在连接电脑…' : remote.token ? '刷新打印状态' : '重新连接打印电脑'}
      </button>
    </div>
    <p className={connectionStyles.description}>{remote.token
      ? remote.device ? `${remote.device.name} · ${remote.device.printer}` : '正在读取打印电脑信息'
      : '自动连接本仓库的打印电脑，连接后可直接发送单据。'}</p>
    {remote.deviceError && <p role='alert' className={styles.error}>{remote.deviceError}</p>}
    {remote.message && <p role='alert' className={styles.error}>{remote.message}</p>}
    {remote.job && <RemotePrint remote={remote} open showSendAction={false} />}
  </section>;
}
