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
    defineConstants: {
      // Demo builds may point at a local, isolated API. Release builds leave
      // this empty and keep the canonical HTTPS endpoint unchanged.
      __WAREHOUSE_DEMO_API_ORIGIN__: JSON.stringify(process.env.TARO_DEMO_API_ORIGIN || '')
    },
    copy: {
      patterns: [
        { from: 'src/preview-pages/index.html', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/index.html' },
        { from: 'src/preview-pages/customers.html', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/customers.html' },
        { from: 'src/preview-pages/management.html', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/management.html' },
        { from: 'src/preview-pages/print.html', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/print.html' },
        { from: 'src/preview-pages/preview-shared.css', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/preview-shared.css' },
        { from: 'src/preview-pages/preview-store.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/preview-store.js' },
        { from: 'src/preview-pages/dimension-input.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/dimension-input.js' },
        { from: 'src/preview-pages/print-enhancements.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/print-enhancements.js' },
        { from: 'src/preview-pages/project-print-template.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/preview-pages/project-print-template.js' },
        { from: 'src/mobile/index.html', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/mobile.html' },
        { from: 'src/mobile/entry.js', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/mobile-entry.js' },
        { from: 'src/styles/web-shell.css', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/css/web-shell.css' }
        ,{ from: 'src/assets/favicon.svg', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/assets/favicon.svg' },
        { from: 'src/assets/label-fonts/OFL.txt', to: (process.env.TARO_OUTPUT_DIR || 'dist') + '/static/fonts/assets/label-fonts/OFL.txt' }
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
        chain.devtool(mode === 'production' ? false : 'source-map');
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
