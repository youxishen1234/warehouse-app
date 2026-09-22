import React, { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { accountApi, session, sessionOrigin, setSession, watchSession } from '@/services/session';
import { refreshSharedData } from '@/services/shared-refresh';

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
    const poll = async () => {
      if (!current) return;
      try {
        const response = await fetch(`${sessionOrigin()}/api/sync?t=${Date.now()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${current.token}` } });
        if (!response.ok) return;
        const body = await response.json();
        const next = String(body?.data?.revision ?? '');
        if (alive && revision && next !== revision) refreshSharedData();
        revision = next;
      } catch (error) { /* request layer handles transient network failures */ }
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [current?.token]);

  // 页面节点必须始终挂载，Taro 会在首帧查找页面实例；连接期间只覆盖一层状态提示。
  return <>{children}{booting && !current && <View className="team-boot"><Text>正在连接共享仓库…</Text></View>}</>;
}
