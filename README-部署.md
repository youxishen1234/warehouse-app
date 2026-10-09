# 🚀 纸板管理系统 - 部署包

## 📦 包含文件

| 文件名 | 大小 | 说明 |
|--------|------|------|
| `board-pages-upload.zip` | 9.57 KB | 纸板管理三个页面（入库/库存/领料） |
| `app-config-upload.zip` | 0.64 KB | 更新的应用配置文件 |
| `deploy.ps1` | 3.42 KB | Windows 自动部署脚本 |
| `deploy.sh` | 3.08 KB | Linux/Mac 自动部署脚本 |
| `部署说明-纸板管理系统.md` | 3.75 KB | 详细部署文档 |
| `部署检查清单.md` | 4.92 KB | 部署前后检查清单 |

## 🎯 快速开始

### Windows 用户

```powershell
# 1. 打开 PowerShell
# 2. 进入本目录
cd E:\aoo\warehouse-app

# 3. 执行部署脚本
.\deploy.ps1
```

### Linux/Mac 用户

```bash
# 1. 打开终端
# 2. 进入本目录
cd /path/to/warehouse-app

# 3. 赋予执行权限
chmod +x deploy.sh

# 4. 执行部署脚本
./deploy.sh
```

## 📝 部署脚本功能

自动部署脚本会完成以下操作：

1. ✅ 检查本地文件完整性
2. ✅ 上传文件到服务器 `/tmp/`
3. ✅ 自动备份现有代码到 `/opt/shuguang/backups/`
4. ✅ 解压并部署新文件
5. ✅ 设置正确的文件权限
6. ✅ 重新编译项目
7. ✅ 重启 Node 服务
8. ✅ 验证服务状态

## 🔐 前置要求

- SSH 可以连接到 `ubuntu@152.136.100.200`
- 有 sudo 权限（用于重启服务）
- 服务器上已安装 Node.js 和项目依赖
- 已配置 SSH 密钥认证（推荐）

## 📱 新增功能

### 1️⃣ 纸板入库
- 路径: `/pages/board-inbound/index`
- 供应商管理
- 纸板规格录入（展开尺寸、楞型、克重）
- 数量管理（订购/送货/赠送）
- 自动计算计费平米

### 2️⃣ 纸板库存
- 路径: `/pages/board-stock/index`
- 库存总览与统计
- 多规格展示
- 状态筛选（全部/充足/预警）
- 快捷操作（入库/领料/详情/二维码）

### 3️⃣ 纸板领料
- 路径: `/pages/board-outbound/index`
- 规格选择
- 领料数量录入
- 领料人与用途记录

## 🔄 底部导航更新

**原来**: 首页 | **入库** | 订单 | 我的

**现在**: 首页 | **纸板** | 订单 | 我的

点击"纸板"进入纸板库存页面

## ⚠️ 重要提示

### 需要后端配合

部署前端后，还需要后端实现以下 API：

```
GET  /api/board/stock          # 获取库存列表
POST /api/board/inbound        # 纸板入库
POST /api/board/outbound       # 纸板领料
GET  /api/board/suppliers      # 获取供应商列表
GET  /api/board/statistics     # 获取统计数据
```

### 需要数据库表

- `board_stock` - 纸板库存表
- `board_inbound` - 入库记录表
- `board_outbound` - 领料记录表

详见 `部署说明-纸板管理系统.md` 中的数据表结构

## 🧪 部署后验证

```bash
# 1. 检查服务状态
ssh ubuntu@152.136.100.200 "sudo systemctl status shuguang.service"

# 2. 检查文件是否部署
ssh ubuntu@152.136.100.200 "ls -la /opt/shuguang/src/pages/ | grep board"

# 3. 访问网站
http://152.136.100.200
```

## 📚 文档说明

- **部署说明-纸板管理系统.md**: 详细的手动部署步骤和注意事项
- **部署检查清单.md**: 部署前后的完整检查清单、API 说明、数据表结构

## 🆘 遇到问题？

### SSH 连接失败
```bash
# 检查 SSH 密钥
ssh -v ubuntu@152.136.100.200

# 或者手动输入密码
ssh ubuntu@152.136.100.200
```

### 服务启动失败
```bash
# 查看服务日志
ssh ubuntu@152.136.100.200 "sudo journalctl -u shuguang.service -f"

# 检查端口占用
ssh ubuntu@152.136.100.200 "netstat -tlnp | grep 4000"
```

### 编译失败
```bash
# 清除缓存重新编译
ssh ubuntu@152.136.100.200 "cd /opt/shuguang && rm -rf node_modules/.cache && npm run build:weapp"
```

## 📧 联系方式

部署过程中如有问题，请提供：
1. 错误信息截图
2. 服务日志输出
3. 执行的具体命令

---

**开发日期**: 2026年9月30日  
**版本**: v1.0.0  
**技术栈**: Taro 3.x + React + TypeScript
