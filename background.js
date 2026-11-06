// 浏览器备份 · service worker
// 点击工具栏图标时打开主界面（已打开则聚焦，避免重复开标签）

const APP_URL = chrome.runtime.getURL('app.html');

chrome.action.onClicked.addListener(async () => {
  try {
    const opened = await chrome.tabs.query({ url: APP_URL });
    if (opened.length > 0) {
      await chrome.tabs.update(opened[0].id, { active: true });
      await chrome.windows.update(opened[0].windowId, { focused: true });
      return;
    }
  } catch (e) {
    // 查询失败时直接新开一个，不影响主流程
  }
  await chrome.tabs.create({ url: APP_URL });
});

// 首次安装时自动打开一次，省得用户找不到入口
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: APP_URL });
  }
});
