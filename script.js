// ---------------------------------------------------------------------------
// 儲存層：網頁版用 localStorage，若在 Chrome 擴充功能中執行則用 chrome.storage
// ---------------------------------------------------------------------------
const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? {
      get: (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve)),
      set: (items) => new Promise((resolve) => chrome.storage.local.set(items, resolve))
    }
  : {
      get: (keys) => {
        const result = {};
        keys.forEach((key) => {
          try {
            const raw = localStorage.getItem(key);
            if (raw !== null) result[key] = JSON.parse(raw);
          } catch (e) {
            console.warn(`讀取 ${key} 失敗，已略過`, e);
          }
        });
        return Promise.resolve(result);
      },
      set: (items) => {
        Object.entries(items).forEach(([key, value]) => {
          localStorage.setItem(key, JSON.stringify(value));
        });
        return Promise.resolve();
      }
    };

let currentTasks = [];
// 預設設定
let userSettings = {
  apiKey: '',
  model: 'gemini-flash-latest'
};

const $ = (id) => document.getElementById(id);

function showStatus(el, message, type = 'info') {
  el.textContent = message;
  el.className = `status ${type}`;
}

function clearStatus(el) {
  el.textContent = '';
  el.className = 'status';
}

document.addEventListener('DOMContentLoaded', async () => {
  const settingsPanel = $('settingsPanel');
  const settingsStatus = $('settingsStatus');
  const statusMsg = $('statusMsg');
  const submitBtn = $('submitBtn');
  const taskInput = $('taskInput');

  // 載入任務與設定
  const result = await storage.get(['savedTasks', 'appSettings']);

  if (Array.isArray(result.savedTasks)) {
    currentTasks = result.savedTasks;
  }
  renderTasks();

  if (result.appSettings) {
    userSettings = { ...userSettings, ...result.appSettings };
    $('apiKeyInput').value = userSettings.apiKey || '';
    // 確保下拉選單的值與設定一致，如果沒有則維持預設選項
    const modelSelect = $('modelSelect');
    const optionExists = Array.from(modelSelect.options).some((opt) => opt.value === userSettings.model);
    if (optionExists) {
      modelSelect.value = userSettings.model;
    }
  }

  // 第一次使用（還沒設定 Key）時自動展開設定面板
  if (!userSettings.apiKey) {
    openSettings();
    showStatus(settingsStatus, '第一次使用請先輸入 Gemini API Key。', 'info');
  }

  function openSettings() {
    settingsPanel.classList.remove('hidden');
    $('toggleSettings').setAttribute('aria-expanded', 'true');
  }

  // 設定面板開關
  $('toggleSettings').addEventListener('click', () => {
    const isHidden = settingsPanel.classList.toggle('hidden');
    $('toggleSettings').setAttribute('aria-expanded', String(!isHidden));
    if (isHidden) clearStatus(settingsStatus);
  });

  // 儲存設定按鈕
  $('saveSettingsBtn').addEventListener('click', async () => {
    userSettings.apiKey = $('apiKeyInput').value.trim();
    userSettings.model = $('modelSelect').value;

    if (!userSettings.apiKey) {
      showStatus(settingsStatus, '請先輸入 API Key 再儲存。', 'error');
      return;
    }

    await storage.set({ appSettings: userSettings });
    showStatus(settingsStatus, '✅ 設定已儲存！', 'info');
    setTimeout(() => {
      settingsPanel.classList.add('hidden');
      $('toggleSettings').setAttribute('aria-expanded', 'false');
      clearStatus(settingsStatus);
    }, 1200);
  });

  // 送出：按鈕，或在輸入框按 Ctrl/⌘ + Enter
  submitBtn.addEventListener('click', handleSubmit);
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  });

  async function handleSubmit() {
    const input = taskInput.value.trim();
    if (!input) {
      showStatus(statusMsg, '請先輸入任務內容。', 'error');
      return;
    }

    if (!userSettings.apiKey) {
      showStatus(statusMsg, '請先點擊右上角「⚙️ 設定」輸入您的 Gemini API Key。', 'error');
      openSettings();
      return;
    }

    submitBtn.disabled = true;
    showStatus(statusMsg, '🤖 AI 解析中...', 'info');

    const prompt = `
    你是一個代辦事項助理。請從以下使用者的話語中萃取出任務資訊，並以嚴格的 JSON 陣列格式回傳，不要包含其他文字。
    JSON 格式範例：[{"task": "回覆廠商關於離心泵浦的報價", "time": "明天早上", "priority": "高"}]
    若使用者沒有提到時間或優先度，time 請填「未指定」，priority 請填「中」。
    使用者的話：${input}
  `;

    try {
      // 這裡使用 userSettings 裡的模型與金鑰
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(userSettings.model)}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': userSettings.apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || `HTTP 錯誤狀態碼: ${response.status}`);
      }

      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!resultText) {
        throw new Error('AI 沒有回傳可用的內容，請換個說法再試一次。');
      }

      const newTasks = parseTasks(resultText);
      if (newTasks.length === 0) {
        throw new Error('沒有解析出任何任務，請換個說法再試一次。');
      }

      currentTasks = currentTasks.concat(newTasks);
      await saveAndRender();
      taskInput.value = '';
      showStatus(statusMsg, `✅ 已新增 ${newTasks.length} 筆任務。`, 'info');
      setTimeout(() => clearStatus(statusMsg), 2500);
    } catch (error) {
      console.error('發生錯誤詳細資訊:', error);
      showStatus(statusMsg, `連線或處理失敗：${error.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  }
});

// 把 AI 回傳的文字轉成任務陣列（容錯：去掉 ```json 包裝、只取 JSON 陣列的部分）
function parseTasks(rawText) {
  let text = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list
    .filter((item) => item && typeof item === 'object' && item.task)
    .map((item) => ({
      task: String(item.task),
      time: String(item.time || '未指定'),
      priority: String(item.priority || '中')
    }));
}

// 抽出儲存並重繪的函式，方便重複使用
async function saveAndRender() {
  await storage.set({ savedTasks: currentTasks });
  renderTasks();
}

function makeButton(className, text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderTasks() {
  const list = $('taskList');
  const emptyState = $('emptyState');
  list.innerHTML = '';

  emptyState.classList.toggle('hidden', currentTasks.length > 0);

  currentTasks.forEach((t, index) => {
    const li = document.createElement('li');
    li.className = 'task-item';

    // -- 顯示模式的區塊（用 textContent 避免任務文字被當成 HTML 解析）--
    const displayDiv = document.createElement('div');
    displayDiv.className = 'task-body';

    const priority = document.createElement('strong');
    priority.textContent = `[${t.priority}優先] `;

    const taskText = document.createElement('span');
    taskText.textContent = t.task;

    const timeText = document.createElement('small');
    timeText.className = 'task-meta';
    timeText.textContent = `🕒 ${t.time}`;

    displayDiv.append(priority, taskText, timeText);

    // -- 動作按鈕區塊 --
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'task-actions';

    // 向上移按鈕
    const upBtn = makeButton('btn-sm btn-move', '▲', () => {
      if (index > 0) {
        [currentTasks[index - 1], currentTasks[index]] = [currentTasks[index], currentTasks[index - 1]];
        saveAndRender();
      }
    });
    upBtn.disabled = (index === 0);
    upBtn.setAttribute('aria-label', '往上移');

    // 向下移按鈕
    const downBtn = makeButton('btn-sm btn-move', '▼', () => {
      if (index < currentTasks.length - 1) {
        [currentTasks[index + 1], currentTasks[index]] = [currentTasks[index], currentTasks[index + 1]];
        saveAndRender();
      }
    });
    downBtn.disabled = (index === currentTasks.length - 1);
    downBtn.setAttribute('aria-label', '往下移');

    // -- 編輯模式的區塊 (預設隱藏) --
    const editForm = document.createElement('div');
    editForm.className = 'edit-form hidden';

    const taskField = document.createElement('input');
    taskField.type = 'text';
    taskField.placeholder = '任務名稱';
    taskField.value = t.task;

    const timeField = document.createElement('input');
    timeField.type = 'text';
    timeField.placeholder = '時間';
    timeField.value = t.time;

    const priorityField = document.createElement('input');
    priorityField.type = 'text';
    priorityField.placeholder = '優先度';
    priorityField.value = t.priority;

    const editActions = document.createElement('div');
    editActions.className = 'task-actions';

    const exitEditMode = () => {
      displayDiv.classList.remove('hidden');
      actionsDiv.classList.remove('hidden');
      editForm.classList.add('hidden');
    };

    const saveEditBtn = makeButton('btn-sm btn-done', '儲存', () => {
      const newTask = taskField.value.trim();
      if (!newTask) return;
      t.task = newTask;
      t.time = timeField.value.trim() || '未指定';
      t.priority = priorityField.value.trim() || '中';
      saveAndRender();
    });

    const cancelEditBtn = makeButton('btn-sm btn-move', '取消', () => {
      taskField.value = t.task;
      timeField.value = t.time;
      priorityField.value = t.priority;
      exitEditMode();
    });

    editActions.append(saveEditBtn, cancelEditBtn);
    editForm.append(taskField, timeField, priorityField, editActions);

    // 編輯按鈕
    const editBtn = makeButton('btn-sm btn-edit', '編輯 ✎', () => {
      displayDiv.classList.add('hidden');
      actionsDiv.classList.add('hidden');
      editForm.classList.remove('hidden');
      taskField.focus();
    });

    // 完成(刪除)按鈕
    const doneBtn = makeButton('btn-sm btn-done', '完成 ✔', () => {
      currentTasks.splice(index, 1);
      saveAndRender();
    });

    actionsDiv.append(upBtn, downBtn, editBtn, doneBtn);

    li.append(displayDiv, actionsDiv, editForm);
    list.appendChild(li);
  });
}
