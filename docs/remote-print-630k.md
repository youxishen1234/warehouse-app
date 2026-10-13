# 630K 远程打印

手机保存送货单，在预览里展开“远程打印到店里”，粘贴电脑提供的配对码，然后发送到630K。电脑和打印机必须保持开机联网。

服务器的 remote-print.json 和电脑 agent.json 是私有配置，不能提交到 Git 或放在 public 目录。服务器保存配对凭据的摘要；手机凭据仅允许向对应电脑发任务，电脑凭据仅用于接收和回执。配对码需要保密。

接收程序启动命令为 node scripts/remote-print-agent.cjs 加上 agent.json 绝对路径。配置字段为 origin、agent、printer；origin 固定为 https://youxishen.online，printer 为 Windows 完整驱动名称。注册在服务器本地调用 remote-print.js 的 createStore(...).register(name, printer)，不提供公开注册接口。

Windows 长期运行请使用 `scripts/install-remote-print-task.ps1 -ConfigFile <agent.json绝对路径> -Start`，不要让接收程序依赖可被关闭的命令窗口。配置目录下须有 `scripts/remote-print-agent.cjs` 和原有打印依赖。安装脚本将隐藏启动器复制到接收目录，备份已有计划任务配置，保留 Windows 运行账户，并设置登录启动、每分钟恢复检查和单实例运行。已有任务正在打印时不会被中断；新设置从下一次启动生效。电脑需要登录该账户，接收程序才可使用该账户的打印机驱动。

排查“发送没反应”时先检查打印电脑是否在线，再检查 Windows 打印队列。接收目录的 `supervisor.log` 记录启动和退出码，`receiver.log`、`receiver-error.log` 记录最近一次运行；重启会保留旧日志。安装脚本支持 `-WhatIf` 预览变更。不应删除 `jobs.json` 或重置不确定任务来强行恢复，以免重复出纸。

电脑每1秒检查任务，只有指定实体打印机可用时才领取。已结束任务可点“再打印一份”，检查队列和实际出纸后确认才创建新的任务。领取后服务器不自动重新投递；电脑在调用打印驱动前落盘任务编号，网络重试和程序重启不会自动重复打印。发生结果不确定时队列暂停，需要核对实际出纸。状态“已送入打印队列”表示 Windows 接受任务，不等于已经出纸。

远程打印只发单据快照，不执行出库、改订单或账务。使用“确认出库并打印”完成出库后，也可在预览发送远程打印。

