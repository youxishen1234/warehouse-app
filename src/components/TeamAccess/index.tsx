import React, { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { accountApi, session, setSession, watchSession } from '@/services/session';
import { getBaseUrl } from '@/services/request';
import { refreshSharedData } from '@/services/shared-refresh';
import './style.scss';

export default function TeamAccess({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState(session());
  const [booting, setBooting] = useState(!session());

  useEffect(() => {
    let guestRequesting = false;
    const connectGuest = () => {
      if (guestRequesting || session()) return;
      guestRequesting = true;
      setBooting(true);
      accountApi('/auth/guest', 'POST')
        .then(result => setSession(result))
        .catch(() => setBooting(false))
        .finally(() => { guestRequesting = false; });
    };
    const stopWatching = watchSession(() => {
      const next = session();
      setCurrent(next);
      if (next) { setBooting(false); refreshSharedData(); }
      else connectGuest();
    });
    connectGuest();
    return stopWatching;
  }, []);

  useEffect(() => {
    let alive = true;
    let revision = '';
    let polling = false;
    const poll = async () => {
      if (!current || polling || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      polling = true;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${current.token}` };
        // Older deployed servers reject If-None-Match during CORS preflight.
        // Compare JSON revisions instead; polling still detects shared changes.
        const response = await fetch(`${getBaseUrl()}/api/sync`, { cache: 'no-store', headers });
        if (response.status === 401) { setSession(null); return; }
        if (response.status === 304) return;
        if (!response.ok) return;
        const body = await response.json();
        const next = String(body?.data?.revision ?? '');
        if (alive && revision && next !== revision) refreshSharedData(next);
        revision = next;
      } catch (error) { /* request layer handles transient network failures */ }
      finally { polling = false; }
    };
    poll();
    const timer = setInterval(poll, 4000);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible); };
  }, [current]);

  // 页面节点必须始终挂载，Taro 会在首帧查找页面实例；连接期间只覆盖一层状态提示。
  return <>{children}{booting && !current && <View className="team-boot"><Text>正在连接共享仓库…</Text></View>}</>;
}
