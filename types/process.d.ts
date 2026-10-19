declare const process: {
  env: {
    NODE_ENV?: string;
    TARO_ENV?: string;
    TARO_APP_ENV?: string;
    [key: string]: string | undefined;
  };
};
