import React, { useRef, useState, useEffect } from 'react';
import { View, type ITouchEvent } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

// ============================================
// SwipeRow：左滑列表项，露出右侧操作按钮（编辑/删除等）
// - 受控组件：open / onOpenChange 由父级管理（一次只开一行）
// - 纵向滑动交给页面滚动，横向滑动由组件接管
// - H5 与微信小程序均可用（Touch 事件 + inline px 定位）
// ============================================

export interface SwipeAction {
  text: string;
  /** 按钮背景色，默认主题蓝 */
  bg?: string;
  /** 文字颜色，默认白色 */
  color?: string;
  onClick: () => void;
}

interface SwipeRowProps {
  children: React.ReactNode;
  actions: SwipeAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 点击内容区（未展开时）触发 */
  onTap?: () => void;
}

// 单个操作按钮宽度（rpx）
const ACTION_W = 176;

// rpx → px（750rpx = windowWidth；H5 与微信一致）
const SYS = Taro.getSystemInfoSync();
const R = (SYS.windowWidth || 375) / 750;

const SwipeRow: React.FC<SwipeRowProps> = ({ children, actions, open, onOpenChange, onTap }) => {
  const unitPx = ACTION_W * R;
  const totalPx = unitPx * actions.length;

  const [trans, setTrans] = useState(open ? -totalPx : 0);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, y: 0, dx: 0, dy: 0, moved: false, horiz: false, base: 0 });

  // 外部 open 状态变化时同步位置（非拖拽中）
  useEffect(() => {
    if (!dragging) setTrans(open ? -totalPx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, totalPx]);

  const onTouchStart = (e: ITouchEvent) => {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, moved: false, horiz: false, base: open ? -totalPx : 0 };
  };

  const onTouchMove = (e: ITouchEvent) => {
    const t = e.touches[0];
    const s = startRef.current;
    s.dx = t.clientX - s.x;
    s.dy = t.clientY - s.y;

    // 尚未判定方向：位移过小先不动；纵向优先时交给页面滚动
    if (!s.horiz) {
      if (Math.abs(s.dx) < 8 && Math.abs(s.dy) < 8) return;
      if (Math.abs(s.dy) > Math.abs(s.dx)) return; // 纵向滚动
      s.horiz = true;
    }

    s.moved = true;
    setDragging(true);
    // 已展开时从 -totalPx 起算；未展开时从 0 起算
    let off = s.horiz ? s.base + s.dx : 0;
    off = Math.max(-totalPx, Math.min(0, off));
    setTrans(off);
  };

  const onTouchEnd = () => {
    const s = startRef.current;
    if (!s.moved) {
      s.horiz = false;
      return;
    }
    // 滑出超过 1/3 宽度则保持展开，否则收回
    const shouldOpen = s.base + s.dx < -totalPx / 3;
    onOpenChange(shouldOpen);
    setTrans(shouldOpen ? -totalPx : 0);
    setDragging(false);
    s.horiz = false;
    s.moved = false;
  };

  const onTouchCancel = onTouchEnd;

  const handleContentTap = (e: ITouchEvent) => {
    if (open) {
      // 已展开时点击内容：收起
      e.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (onTap) onTap();
  };

  return (
    <View className={styles.wrap}>
      {/* 操作层 */}
      <View className={styles.actions}>
        {actions.map((a, i) => (
          <View
            key={i}
            className={styles.actionBtn}
            style={{ width: `${unitPx}px`, background: a.bg || '#2f6bff', color: a.color || '#ffffff' }}
            onClick={(e: ITouchEvent) => {
              e.stopPropagation();
              onOpenChange(false);
              a.onClick();
            }}
          >
            {a.text}
          </View>
        ))}
      </View>

      {/* 内容层 */}
      <View
        className={`${styles.content} ${dragging ? styles.dragging : ''}`}
        style={{ transform: `translateX(${trans}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onClick={handleContentTap}
      >
        {children}
      </View>
    </View>
  );
};

export default SwipeRow;