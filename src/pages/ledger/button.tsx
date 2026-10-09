import React from 'react';
import { Button as TaroButton } from '@tarojs/components';
import type { ButtonProps } from '@tarojs/components';

// Taro's H5 button is a custom element; supply native button keyboard behavior.
export default function Button(props: ButtonProps) {
  return <TaroButton {...props} {...{
    role: 'button', tabIndex: props.disabled ? -1 : 0, 'aria-disabled': Boolean(props.disabled),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (!props.disabled && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.currentTarget.click();
      }
    }
  }} />;
}
