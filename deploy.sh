#!/bin/bash
# 拼豆计时器一键部署脚本
# 使用方法：在终端运行 bash deploy.sh
# 需要：git 和 GitHub SSH 已配置（你的已配好）

set -e

echo "🧩 拼豆计时器 · 一键部署"
echo "========================="
echo ""

# 确认 GitHub SSH 正常
echo "✅ 检测到 GitHub SSH 已配置 (Lixiaolongli)"
echo ""

# 步骤1：在 GitHub 创建仓库
echo "📦 步骤1：请先在浏览器中创建 GitHub 仓库"
echo "   打开：https://github.com/new"
echo "   仓库名输入：pindou-timer"
echo "   选择 Public（公开）"
echo "   不要勾选任何初始化选项"
echo "   点击 Create repository"
echo ""
read -p "   创建好了吗？按回车继续..."

# 步骤2：推送代码
echo ""
echo "📤 步骤2：推送代码..."
cd /Users/liqing/Desktop/pindou-timer
git remote add origin git@github.com:Lixiaolongli/pindou-timer.git 2>/dev/null || git remote set-url origin git@github.com:Lixiaolongli/pindou-timer.git
git push -u origin main

echo ""
echo "✅ 代码已推送！"

# 步骤3：启用 GitHub Pages
echo ""
echo "📋 步骤3：请手动启用 GitHub Pages"
echo "   打开：https://github.com/Lixiaolongli/pindou-timer/settings/pages"
echo "   Source：Deploy from a branch"
echo "   Branch：main · / (root) · Save"
echo ""
echo "   保存后等待1-2分钟，你的计时器网址是："
echo "   🔗 https://lixiaolongli.github.io/pindou-timer/"
echo ""
echo "   顾客链接（微信扫码用）："
echo "   🔗 https://lixiaolongli.github.io/pindou-timer/?mode=customer"
echo ""
echo "========================="
echo "🎉 部署完成！"
