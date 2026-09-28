import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import devConfig from './dev';
import prodConfig from './prod';
// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'webpack5'>(async (merge, { mode }) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'taro_template',
    date: '2025-12-10',
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: process.env.TARO_OUTPUT_DIR || 'dist',
    plugins: ['@tarojs/plugin-html'],
    defineConstants: {},
    copy: {
      patterns: [
        { from: 'www/js/home-search.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/js/home-search.js' },
        { from: 'www/css/polish.css', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/css/polish.css' }
        ,{ from: 'src/assets/favicon.svg', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/assets/favicon.svg' }
      ],
      options: {},
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: {
        enable: false,
      },
    },
    cache: {
      enable: false, // Webpack 持久化缓存配置，建议开启。默认配置请参考：https://docs.taro.zone/docs/config-detail#cache
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {
            selectorBlackList: ['nut-'],
          },
        },
        cssModules: {
          enable: true, // 开启 CSS Modules
          config: {
            namingPattern: 'module', // 仅 *.module.scss 生效
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
      webpackChain(chain) {
        chain.resolve.plugin('tsconfig-paths').use(TsconfigPathsPlugin);
      },
    },
    h5: {
      // Web builds must resolve assets from the site root so refreshing a
      // deep hash/history URL cannot turn /pages/x/js/app.js into a 404.
      // Native/desktop packaging passes TARO_PUBLIC_PATH=./ to keep file://
      // assets relative to the bundled index.html.
      publicPath: process.env.TARO_PUBLIC_PATH || '/',
      staticDirectory: 'static',
      output: {
        filename: 'js/[name].[hash:8].js',
        chunkFilename: 'js/[name].[chunkhash:8].js',
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css',
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: true, // 开启 CSS Modules
          config: {
            namingPattern: 'module', // 仅 *.module.scss 生效
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
        pxtransform: {
          enable: true,
          config: {
            selectorBlackList: ['body', 'team-'],
            baseFontSize: 37.5,
            unitPrecision: 5,
          },
        },
      },
      webpackChain(chain) {
        // Production packages are distributed to H5, Capacitor and Electron.
        // Keep source maps out of those packages; development keeps the
        // toolchain default for local debugging. Taro passes the build mode
        // to this callback, so keep the policy in the H5 chain itself.
        if (mode === 'production') chain.devtool(false);
        chain.resolve.plugin('tsconfig-paths').use(TsconfigPathsPlugin);
        if (process.env.TARO_STATS === '1') {
          chain.plugin('warehouse-stats').use(class WarehouseStatsPlugin {
            apply(compiler: any) {
              compiler.hooks.done.tap('WarehouseStatsPlugin', (stats: any) => {
                const fs = require('node:fs');
                const path = require('node:path');
                const output = process.env.TARO_STATS_PATH || path.join(process.cwd(), 'release', 'webpack-stats.json');
                fs.mkdirSync(path.dirname(output), { recursive: true });
                fs.writeFileSync(output, JSON.stringify(stats.toJson({ all: false, assets: true, chunks: true, modules: true }), null, 2));
              });
            }
          });
        }
      },
    },
    rn: {
      appName: 'taroDemo',
      postcss: {
        cssModules: {
          enable: true,
        },
      },
    },
  };
  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
