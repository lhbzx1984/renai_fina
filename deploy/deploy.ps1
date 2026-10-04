<#
.SYNOPSIS
  天津仁爱学院报销系统 · Windows 云主机一键部署（阿里云/腾讯云 Windows Server）

.DESCRIPTION
  用 Windows 服务 + NSSM 守护进程，适用于 Windows Server 2016/2019/2022。
  若服务器是 Linux，请改用 deploy.sh（功能更完整，含 systemd 与 Nginx）。

.PARAMETER Port
  应用监听端口，默认 5180

.PARAMETER InstallDir
  安装目录，默认 C:\reimburse

.PARAMETER DataDir
  数据目录，默认 C:\reimburse\data

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -AuthUser admin -AuthPass 'xxx'

.NOTES
  需要以管理员身份运行。
#>
[CmdletBinding()]
param(
  [int]$Port = 5180,
  [string]$InstallDir = 'C:\reimburse',
  [string]$DataDir = 'C:\reimburse\data',
  [string]$ServiceName = 'reimburse',
  [string]$AuthUser = 'admin',
  [string]$AuthPass = '',
  [switch]$SkipIis
)

$ErrorActionPreference = 'Stop'

function Write-Step { param($m) Write-Host "`n▌$m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "  [ERR]  $m" -ForegroundColor Red }

# ---------- 管理员检查 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '请以管理员身份运行：右键 PowerShell → 使用管理员身份运行' }

$srcDir = Split-Path -Parent $PSScriptRoot

Write-Step '天津仁爱学院报销系统 · Windows 部署'
Write-Host "  源码目录 : $srcDir"
Write-Host "  安装目录 : $InstallDir"
Write-Host "  数据目录 : $DataDir"

# ---------- 1. Node.js 检查 ----------
Write-Step '1/6 Node.js 运行时'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw '未检测到 Node.js。请安装 Node.js 22 LTS 及以上版本：https://nodejs.org/'
}
$nodeVer = (& node -v) -replace '^v', ''
$major = [int]($nodeVer.Split('.')[0])
Write-Ok "Node.js $nodeVer（$nodeCmd.Source）"
if ($major -lt 22) {
  throw "Node.js 版本过低（$nodeVer）。本项目依赖 Node 22 内置的 node:sqlite，请升级到 22.5 以上。"
}

# 验证 node:sqlite 真的可用（这是本项目的硬依赖）
$sqliteCheck = & node -e "require('node:sqlite'); console.log('ok')" 2>&1
if ($sqliteCheck -match 'ok') {
  Write-Ok 'node:sqlite 可用'
} else {
  throw "当前 Node.js 无法加载 node:sqlite。`n请升级到 Node 22.5 以上版本。"
}

# ---------- 2. 目录 ----------
Write-Step '2/6 创建目录'
foreach ($d in @($InstallDir, $DataDir, "$DataDir\uploads", "$DataDir\exports", "$InstallDir\logs")) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Ok '目录就绪'

# ---------- 3. 复制代码 ----------
Write-Step '3/6 部署应用代码'
foreach ($item in @('server')) {
  $src = Join-Path $srcDir $item
  $dst = Join-Path $InstallDir $item
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src -Destination $dst -Recurse -Force
}
Copy-Item (Join-Path $srcDir 'package.json') -Destination $InstallDir -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $srcDir 'deploy')) {
  $deployDst = Join-Path $InstallDir 'deploy'
  if (-not (Test-Path $deployDst)) { New-Item -ItemType Directory -Path $deployDst -Force | Out-Null }
  Copy-Item (Join-Path $srcDir 'deploy\*') -Destination $deployDst -Recurse -Force
}
Write-Ok "代码已部署到 $InstallDir"

# ---------- 4. 启动脚本（内含环境变量，含密码，权限受限）----------
Write-Step '4/6 生成启动脚本与凭据'
if (-not $AuthPass) {
  # 生成 20 位随机密码
  $bytes = New-Object byte[] 15
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $AuthPass = -join ($bytes | ForEach-Object { 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[$_ % 57] })
  $generated = $true
}

$launcher = Join-Path $InstallDir 'run.cmd'
@"
@echo off
REM 由 deploy.ps1 生成。请勿随意修改——修改密码请编辑本文件。
cd /d "$InstallDir"
set HOST=127.0.0.1
set PORT=$Port
set DATA_DIR=$DataDir
set EXPORT_DIR=$DataDir\exports
set AUTH_USER=$AuthUser
set AUTH_PASS=$AuthPass
node --experimental-sqlite server\index.js
"@ | Set-Content -Path $launcher -Encoding Default

# 收紧权限：仅 SYSTEM 与 Administrators 可读（密码在此文件里）
try {
  $acl = Get-Acl $launcher
  $acl.SetAccessRuleProtection($true, $false)   # 阻断继承
  foreach ($who in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $who, 'FullControl', 'Allow')))
  }
  Set-Acl -Path $launcher -AclObject $acl
  Write-Ok '启动脚本已生成并收紧权限（密码仅 SYSTEM/管理员可读）'
} catch {
  Write-Warn "权限收紧失败（不影响运行）：$($_.Exception.Message)"
}

if ($generated) {
  Write-Host ""
  Write-Host "  ┌──────────────────────────────────────────────┐" -ForegroundColor Yellow
  Write-Host "  │  访问账号 : $AuthUser                          " -ForegroundColor Yellow
  Write-Host "  │  访问密码 : $AuthPass        ← 请立即保存       " -ForegroundColor Yellow
  Write-Host "  │  （已生成，可编辑 $launcher 修改）          " -ForegroundColor Yellow
  Write-Host "  └──────────────────────────────────────────────┘" -ForegroundColor Yellow
  Write-Host ""
}

# ---------- 5. 注册 Windows 服务 ----------
Write-Step '5/6 注册 Windows 服务（需 NSSM）'
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  $nssmPath = 'C:\Program Files\nssm\nssm.exe'
  if (Test-Path $nssmPath) { $nssm = $nssmPath }
}
if (-not $nssm) {
  Write-Warn '未找到 NSSM（Windows 服务包装器），跳过服务注册。'
  Write-Warn "请手动运行：$launcher"
  Write-Warn '或下载 NSSM（https://nssm.cc/download）后重新执行本脚本。'
} else {
  $nssmExe = if ($nssm -is [string]) { $nssm } else { $nssm.Source }
  & $nssmExe stop $ServiceName confirm | Out-Null
  & $nssmExe remove $ServiceName confirm 2>&1 | Out-Null
  & $nssmExe install $ServiceName 'C:\Windows\System32\cmd.exe' "/c `"$launcher`"" | Out-Null
  # 用计划任务式重启：崩溃后 5 秒重启
  & $nssmExe set $ServiceName AppExit Default Restart | Out-Null
  & $nssmExe set $ServiceName AppRestartDelay 5000 | Out-Null
  & $nssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
  # stdout/stderr 落日志文件
  & $nssmExe set $ServiceName AppStdout "$InstallDir\logs\stdout.log" | Out-Null
  & $nssmExe set $ServiceName AppStderr "$InstallDir\logs\stderr.log" | Out-Null
  # 限制服务内存，防内存泄漏拖垮整机
  & $nssmExe set $ServiceName AppMemoryLimit 512 | Out-Null
  & $nssmExe start $ServiceName | Out-Null
  Start-Sleep -Seconds 3
  $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') {
    Write-Ok "服务已启动并设置为开机自启（$ServiceName）"
  } else {
    Write-Warn '服务启动异常，请检查日志：'
    if (Test-Path "$InstallDir\logs\stderr.log") { Get-Content "$InstallDir\logs\stderr.log" -Tail 20 }
  }
}

# ---------- 6. 健康检查 ----------
Write-Step '6/6 健康检查'
$healthy = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}
if ($healthy) {
  Write-Ok '健康检查通过'
} else {
  Write-Warn '健康检查未通过。若配置了反向代理，请检查端口与防火墙设置。'
}

# ---------- 完成 ----------
Write-Host "`n════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  部署完成" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  本机访问 : http://127.0.0.1:$Port"
Write-Host "  账号密码 : $AuthUser / $AuthPass"
Write-Host ""
Write-Host "  云平台侧必做："
Write-Host "    · 安全组放行 80 / 443（不要放行 $Port）"
Write-Host "    · 建议配置 HTTPS（证书 + 反向代理）"
Write-Host "    · 若用 IIS：导入 applicationHost.config 后建站点反代到 127.0.0.1:$Port"
Write-Host ""
Write-Host "  常用命令："
Write-Host "    启动服务 : Start-Service $ServiceName"
Write-Host "    停止服务 : Stop-Service $ServiceName"
Write-Host "    查看状态 : Get-Service $ServiceName"
Write-Host "    查看日志 : Get-Content '$InstallDir\logs\stderr.log' -Tail 50 -Wait"
Write-Host ""
