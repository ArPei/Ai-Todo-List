// ---------------------------------------------------------------------------
// 儲存層
// ---------------------------------------------------------------------------
// Chrome 擴充功能:使用 chrome.storage.sync ->只要使用者的 Chrome 有登入同一個帳號並開啟同步,
//                  資料就會自動出現在其他裝置上,不需要架設任何伺服器或資料庫。
// 網頁版(直接開啟 index.html / 部署到 Netlify):退回使用 localStorage,僅存在單一裝置瀏覽器裡。
//
// 注意:chrome.storage.sync 每一個「key」大小上限約 8KB。若把整份清單存成單一個大陣列,
// 清單一長就很容易超過上限而整批存檔失敗。因此這裡把「每一筆任務」拆成獨立的 key(task_<id>),
// 只用一個很小的 taskIndex 記錄目前的排序,大幅降低超出容量的機會。
const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync)
  ? {
      get: (keys) => new Promise((resolve, reject) => {
        chrome.storage.sync.get(keys, (result) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      }),
      set: (items) => new Promise((resolve, reject) => {
        chrome.storage.sync.set(items, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      }),
      remove: (keys) => new Promise((resolve, reject) => {
        if (!keys.length) return resolve();
        chrome.storage.sync.remove(keys, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      })
    }
  : {
      get: (keys) => {
        const result = {};
        keys.forEach((key) => {
          try {
            const raw = localStorage.getItem(key);
            if (raw !== null) result[key] = JSON.parse(raw);
          } catch (e) {
            console.warn(`讀取 ${key} 失敗,已略過`, e);
          }
        });
        return Promise.resolve(result);
      },
      set: (items) => {
        Object.entries(items).forEach(([key, value]) => {
          localStorage.setItem(key, JSON.stringify(value));
        });
        return Promise.resolve();
      },
      remove: (keys) => {
        keys.forEach((key) => localStorage.removeItem(key));
        return Promise.resolve();
      }
    };

// ---------------------------------------------------------------------------
// AI 服務層:由使用者在設定裡手動選擇要用 Gemini 還是 Claude,並固定使用該服務目前
// 官方標示為「穩定 / 最新」的模型,不需要使用者手動選擇模型版本。
// 若服務忙碌(429 / 5xx),會自動重試幾次,降低尖峰時段用不了的機率。
// ---------------------------------------------------------------------------
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyHint: 'AIza 開頭',
    model: 'gemini-flash-latest', // Google 維護的別名,會自動指向目前建議的穩定 Flash 模型
    buildRequest(key, model, prompt) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3 }
          })
        }
      };
    },
    extractText(data) {
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text && data.promptFeedback?.blockReason) {
        throw new Error(`內容被安全機制擋下(${data.promptFeedback.blockReason})`);
      }
      return text || '';
    },
    isRetryable(status) {
      return status === 429 || status === 500 || status === 503;
    }
  },
  anthropic: {
    label: 'Anthropic Claude',
    keyHint: 'sk-ant- 開頭',
    model: 'claude-haiku-4-5-20251001', // 目前最快、最經濟的 Claude 模型,適合這類輕量解析任務
    buildRequest(key, model, prompt) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            // Claude API 預設拒絕瀏覽器直接呼叫,此標頭代表「我知道金鑰會留在使用者瀏覽器裡」。
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }]
          })
        }
      };
    },
    extractText(data) {
      return (data.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    },
    isRetryable(status) {
      return status === 429 || status === 500 || status === 503 || status === 529;
    }
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 呼叫 AI,失敗時針對「暫時性錯誤」(伺服器忙碌/過載)自動重試,其餘錯誤(金鑰錯誤等)直接拋出。
async function callAI(providerId, apiKey, prompt, { retries = 2 } = {}) {
  const provider = PROVIDERS[providerId];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { url, options } = provider.buildRequest(apiKey, provider.model, prompt);
      const response = await fetch(url, options);
      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        // 忽略無法解析成 JSON 的回應內容,交由後續錯誤處理
      }

      if (!response.ok) {
        const message = data.error?.message || data.error?.type || `HTTP 錯誤狀態碼:${response.status}`;
        const err = new Error(message);
        err.retryable = provider.isRetryable(response.status);
        throw err;
      }

      const text = provider.extractText(data);
      if (!text) {
        throw new Error('AI 沒有回傳可用的內容,請換個說法再試一次。');
      }
      return text;
    } catch (err) {
      lastErr = err;
      const canRetry = err.retryable !== false && attempt < retries;
      if (!canRetry) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 分類 / 優先度定義
// ---------------------------------------------------------------------------
const PRIORITY_META = {
  高: { cls: 'high', icon: '🔴' },
  中: { cls: 'mid', icon: '🟠' },
  低: { cls: 'low', icon: '🟢' }
};
const PRIORITY_LIST = Object.keys(PRIORITY_META);

const CATEGORY_META = {
  工作: { cls: 'work', icon: '💼' },
  娛樂: { cls: 'fun', icon: '🎮' },
  追劇: { cls: 'drama', icon: '📺' },
  電影: { cls: 'movie', icon: '🎬' },
  餐廳口袋名單: { cls: 'food', icon: '🍽️' },
  其他: { cls: 'other', icon: '🗂️' }
};
const CATEGORY_LIST = Object.keys(CATEGORY_META);

function normalizePriority(value) {
  const s = String(value || '').trim();
  if (s.includes('高')) return '高';
  if (s.includes('低')) return '低';
  return '中';
}

function normalizeCategory(value) {
  const s = String(value || '').trim();
  const found = CATEGORY_LIST.find((c) => s.includes(c) || c.includes(s));
  return found || '其他';
}

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 相容舊資料:把任何格式的舊任務物件補齊成目前完整欄位
function migrateTask(raw) {
  const steps = Array.isArray(raw.steps) ? raw.steps.map((s) => String(s)) : null;
  return {
    id: raw.id || makeId(),
    task: String(raw.task || ''),
    time: String(raw.time || '未指定'),
    priority: normalizePriority(raw.priority),
    category: normalizeCategory(raw.category),
    steps,
    stepsDone: Array.isArray(raw.stepsDone) && steps
      ? steps.map((_, i) => !!raw.stepsDone[i])
      : (steps ? steps.map(() => false) : null),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  };
}

// ---------------------------------------------------------------------------
// AI 回傳文字 -> JSON 的容錯解析
// ---------------------------------------------------------------------------
function extractJsonArray(rawText) {
  let text = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function buildParsePrompt(input) {
  return `你是一個代辦事項助理。請從以下使用者的話語中萃取出任務資訊,並以嚴格的 JSON 陣列格式回傳,不要包含其他文字、不要使用 Markdown 語法。

每個任務物件需包含以下欄位:
- task:任務內容(字串)
- time:時間敘述,若未提及請填「未指定」
- priority:只能填「高」「中」「低」三者之一,若未提及請填「中」
- category:只能從這些分類中選一個:${CATEGORY_LIST.join('、')},若不確定請填「其他」

JSON 格式範例:
[{"task": "回覆廠商關於離心泵浦的報價", "time": "明天早上", "priority": "高", "category": "工作"}]

使用者的話:${input}`;
}

function parseTasks(rawText) {
  const list = extractJsonArray(rawText);
  return list
    .filter((item) => item && typeof item === 'object' && item.task)
    .map((item) => ({
      id: makeId(),
      task: String(item.task),
      time: String(item.time || '未指定'),
      priority: normalizePriority(item.priority),
      category: normalizeCategory(item.category),
      steps: null,
      stepsDone: null,
      createdAt: Date.now()
    }));
}

function buildStepsPrompt(t) {
  return `請把以下待辦事項拆解成 3 到 6 個循序漸進、具體可執行的步驟。使用繁體中文,並以嚴格 JSON 陣列格式回傳(例如 ["第一步...","第二步..."]),不要包含其他文字或 Markdown。

待辦事項:「${t.task}」(時間:${t.time},分類:${t.category})`;
}

function parseSteps(rawText) {
  const list = extractJsonArray(rawText);
  return list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.step || item.text || item.title || '').trim();
      return '';
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 應用程式狀態
// ---------------------------------------------------------------------------
let currentTasks = [];
let previousTaskIds = new Set();
let userSettings = { apiKey: '', provider: 'gemini' };
let activeFilter = '全部';
const expandedSteps = new Set(); // 目前展開「AI 步驟建議」面板的任務 id

const $ = (id) => document.getElementById(id);

function showStatus(el, message, type = 'info') {
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`;
}

function clearStatus(el) {
  if (!el) return;
  el.textContent = '';
  el.className = 'status';
}

function openSettings() {
  $('settingsPanel').classList.remove('hidden');
  $('toggleSettings').setAttribute('aria-expanded', 'true');
}

function openSettingsWithMessage(message) {
  openSettings();
  showStatus($('settingsStatus'), message, 'error');
}

function updateProviderHint(providerId) {
  const hint = $('providerHint');
  if (!hint) return;
  const provider = PROVIDERS[providerId] || PROVIDERS.gemini;
  hint.textContent = `已選擇:${provider.label}(金鑰格式通常為 ${provider.keyHint}),將自動使用該服務目前的穩定版模型。`;
}

// ---------------------------------------------------------------------------
// 讀取 / 儲存任務(每筆任務各自獨立存放,詳見檔案開頭的儲存層說明)
// ---------------------------------------------------------------------------
async function loadAllTasks() {
  const idxResult = await storage.get(['taskIndex']);
  const ids = Array.isArray(idxResult.taskIndex) ? idxResult.taskIndex : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `task_${id}`);
  const taskResult = await storage.get(keys);
  return ids
    .map((id) => taskResult[`task_${id}`])
    .filter(Boolean)
    .map(migrateTask);
}

async function saveAndRender() {
  try {
    const currentIds = currentTasks.map((t) => t.id);
    const items = { taskIndex: currentIds };
    currentTasks.forEach((t) => {
      items[`task_${t.id}`] = t;
    });
    await storage.set(items);

    const removedIds = [...previousTaskIds].filter((id) => !currentIds.includes(id));
    if (removedIds.length) {
      await storage.remove(removedIds.map((id) => `task_${id}`));
    }
    previousTaskIds = new Set(currentIds);
  } catch (err) {
    console.error('儲存任務失敗:', err);
    showStatus($('statusMsg'), `⚠️ 儲存失敗(裝置同步空間可能已滿,建議先匯出備份):${err.message}`, 'error');
  }
  renderTasks();
}

// ---------------------------------------------------------------------------
// AI 步驟拆解
// ---------------------------------------------------------------------------
async function handleBreakdown(t) {
  if (!userSettings.apiKey) {
    openSettingsWithMessage('請先輸入 API Key,才能使用步驟拆解。');
    return;
  }
  const providerId = userSettings.provider || 'gemini';
  try {
    showStatus($('statusMsg'), `🪄 正在請 ${PROVIDERS[providerId].label} 拆解步驟...`, 'info');
    const raw = await callAI(providerId, userSettings.apiKey, buildStepsPrompt(t));
    const steps = parseSteps(raw);
    if (!steps.length) throw new Error('AI 沒有回傳可用的步驟。');
    t.steps = steps;
    t.stepsDone = steps.map(() => false);
    expandedSteps.add(t.id);
    clearStatus($('statusMsg'));
    await saveAndRender();
  } catch (err) {
    console.error('步驟拆解失敗:', err);
    showStatus($('statusMsg'), `步驟拆解失敗:${err.message}`, 'error');
    setTimeout(() => clearStatus($('statusMsg')), 4000);
  }
}

// ---------------------------------------------------------------------------
// 畫面渲染
// ---------------------------------------------------------------------------
function makeButton(className, text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderCategoryFilters() {
  const row = $('categoryFilters');
  row.innerHTML = '';
  const options = ['全部', ...CATEGORY_LIST];
  options.forEach((cat) => {
    const meta = CATEGORY_META[cat];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-chip${activeFilter === cat ? ' active' : ''}`;
    btn.textContent = meta ? `${meta.icon} ${cat}` : '📋 全部';
    btn.addEventListener('click', () => {
      activeFilter = cat;
      renderTasks();
    });
    row.appendChild(btn);
  });
}

function renderStepsPanel(panel, t) {
  panel.innerHTML = '';
  if (!t.steps || !t.steps.length) return;

  const title = document.createElement('div');
  title.className = 'steps-title';
  title.textContent = '🪄 AI 步驟建議';
  panel.appendChild(title);

  t.steps.forEach((step, si) => {
    const row = document.createElement('label');
    row.className = `step-row${t.stepsDone[si] ? ' done' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.stepsDone[si];
    cb.addEventListener('change', () => {
      t.stepsDone[si] = cb.checked;
      saveAndRender();
    });
    const span = document.createElement('span');
    span.textContent = step;
    row.append(cb, span);
    panel.appendChild(row);
  });

  const regenBtn = makeButton('btn-sm btn-move', '🔄 重新拆解', async () => {
    t.steps = null;
    t.stepsDone = null;
    await saveAndRender();
  });
  panel.appendChild(regenBtn);
}

function buildEditForm(container, t, exitEditMode) {
  container.innerHTML = '';

  const taskField = document.createElement('input');
  taskField.type = 'text';
  taskField.placeholder = '任務名稱';
  taskField.value = t.task;

  const timeField = document.createElement('input');
  timeField.type = 'text';
  timeField.placeholder = '時間(例如:明天早上 10 點)';
  timeField.value = t.time;

  const prioritySelect = document.createElement('select');
  PRIORITY_LIST.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = `${PRIORITY_META[p].icon} ${p}優先`;
    if (p === t.priority) opt.selected = true;
    prioritySelect.appendChild(opt);
  });

  const categorySelect = document.createElement('select');
  CATEGORY_LIST.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = `${CATEGORY_META[c].icon} ${c}`;
    if (c === t.category) opt.selected = true;
    categorySelect.appendChild(opt);
  });

  const editActions = document.createElement('div');
  editActions.className = 'task-actions';

  const saveEditBtn = makeButton('btn-sm btn-done', '儲存', () => {
    const newTask = taskField.value.trim();
    if (!newTask) return;
    t.task = newTask;
    t.time = timeField.value.trim() || '未指定';
    t.priority = prioritySelect.value;
    t.category = categorySelect.value;
    saveAndRender();
  });

  const cancelEditBtn = makeButton('btn-sm btn-move', '取消', exitEditMode);

  editActions.append(saveEditBtn, cancelEditBtn);
  container.append(taskField, timeField, prioritySelect, categorySelect, editActions);
}

function buildTaskItem(t, index, canReorder) {
  const li = document.createElement('li');
  const prioMeta = PRIORITY_META[t.priority] || PRIORITY_META['中'];
  const catMeta = CATEGORY_META[t.category] || CATEGORY_META['其他'];
  li.className = `task-item priority-${prioMeta.cls}`;

  // 顯示模式
  const displayDiv = document.createElement('div');
  displayDiv.className = 'task-body';

  const topRow = document.createElement('div');
  topRow.className = 'task-toprow';
  const catBadge = document.createElement('span');
  catBadge.className = `badge ${catMeta.cls}`;
  catBadge.textContent = `${catMeta.icon} ${t.category}`;
  const prioTag = document.createElement('span');
  prioTag.className = `prio-tag prio-${prioMeta.cls}`;
  prioTag.textContent = `${prioMeta.icon} ${t.priority}優先`;
  topRow.append(catBadge, prioTag);

  const taskText = document.createElement('div');
  taskText.className = 'task-text';
  taskText.textContent = t.task;

  const timeText = document.createElement('small');
  timeText.className = 'task-meta';
  timeText.textContent = `🕒 ${t.time}`;

  displayDiv.append(topRow, taskText, timeText);

  // AI 步驟面板
  const stepsPanel = document.createElement('div');
  stepsPanel.className = `steps-panel${expandedSteps.has(t.id) ? '' : ' hidden'}`;
  renderStepsPanel(stepsPanel, t);

  // 編輯表單(預設隱藏)
  const editForm = document.createElement('div');
  editForm.className = 'edit-form hidden';

  // 動作按鈕
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'task-actions';

  if (canReorder) {
    const upBtn = makeButton('btn-sm btn-move', '▲', () => {
      if (index > 0) {
        [currentTasks[index - 1], currentTasks[index]] = [currentTasks[index], currentTasks[index - 1]];
        saveAndRender();
      }
    });
    upBtn.disabled = index === 0;
    upBtn.setAttribute('aria-label', '往上移');

    const downBtn = makeButton('btn-sm btn-move', '▼', () => {
      if (index < currentTasks.length - 1) {
        [currentTasks[index + 1], currentTasks[index]] = [currentTasks[index], currentTasks[index + 1]];
        saveAndRender();
      }
    });
    downBtn.disabled = index === currentTasks.length - 1;
    downBtn.setAttribute('aria-label', '往下移');
    actionsDiv.append(upBtn, downBtn);
  }

  const aiBtn = makeButton('btn-sm btn-ai', t.steps && t.steps.length ? '🪄 查看步驟' : '🪄 拆解步驟', async () => {
    if (t.steps && t.steps.length) {
      if (expandedSteps.has(t.id)) expandedSteps.delete(t.id);
      else expandedSteps.add(t.id);
      renderTasks();
    } else {
      await handleBreakdown(t);
    }
  });

  const exitEditMode = () => {
    displayDiv.classList.remove('hidden');
    actionsDiv.classList.remove('hidden');
    stepsPanel.classList.toggle('hidden', !expandedSteps.has(t.id));
    editForm.classList.add('hidden');
  };

  const editBtn = makeButton('btn-sm btn-edit', '編輯 ✎', () => {
    displayDiv.classList.add('hidden');
    actionsDiv.classList.add('hidden');
    stepsPanel.classList.add('hidden');
    buildEditForm(editForm, t, exitEditMode);
    editForm.classList.remove('hidden');
  });

  const doneBtn = makeButton('btn-sm btn-done', '完成 ✔', () => {
    currentTasks.splice(index, 1);
    saveAndRender();
  });

  actionsDiv.append(aiBtn, editBtn, doneBtn);

  li.append(displayDiv, actionsDiv, stepsPanel, editForm);
  return li;
}

function renderTasks() {
  renderCategoryFilters();

  const list = $('taskList');
  const emptyState = $('emptyState');
  list.innerHTML = '';

  const visible = currentTasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => activeFilter === '全部' || t.category === activeFilter);

  emptyState.classList.toggle('hidden', visible.length > 0);
  if (visible.length === 0) {
    emptyState.innerHTML = activeFilter === '全部'
      ? '目前沒有代辦事項。<br>在上面輸入一句話,AI 會自動幫你整理成任務。'
      : `「${CATEGORY_META[activeFilter]?.icon || ''} ${activeFilter}」分類目前沒有事項。`;
  }

  const canReorder = activeFilter === '全部';
  visible.forEach(({ t, i }) => {
    list.appendChild(buildTaskItem(t, i, canReorder));
  });
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const settingsPanel = $('settingsPanel');
  const settingsStatus = $('settingsStatus');
  const statusMsg = $('statusMsg');
  const backupStatus = $('backupStatus');
  const submitBtn = $('submitBtn');
  const taskInput = $('taskInput');
  const apiKeyInput = $('apiKeyInput');
  const providerSelect = $('providerSelect');

  // 讀取任務
  try {
    currentTasks = await loadAllTasks();
  } catch (err) {
    console.warn('讀取任務失敗,將視為空清單', err);
    currentTasks = [];
  }
  previousTaskIds = new Set(currentTasks.map((t) => t.id));
  renderTasks();

  // 讀取設定
  const result = await storage.get(['appSettings']).catch(() => ({}));
  if (result.appSettings) {
    userSettings = { ...userSettings, ...result.appSettings };
    apiKeyInput.value = userSettings.apiKey || '';
  }
  providerSelect.value = userSettings.provider || 'gemini';
  updateProviderHint(providerSelect.value);

  // 第一次使用(還沒設定 Key)時自動展開設定面板
  if (!userSettings.apiKey) {
    openSettings();
    showStatus(settingsStatus, '第一次使用請先輸入 Gemini 或 Claude 的 API Key。', 'info');
  }

  // 設定面板開關
  $('toggleSettings').addEventListener('click', () => {
    const isHidden = settingsPanel.classList.toggle('hidden');
    $('toggleSettings').setAttribute('aria-expanded', String(!isHidden));
    if (isHidden) clearStatus(settingsStatus);
  });

  // 切換服務時更新提示文字
  providerSelect.addEventListener('change', () => updateProviderHint(providerSelect.value));

  // 儲存設定
  $('saveSettingsBtn').addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showStatus(settingsStatus, '請先輸入 API Key 再儲存。', 'error');
      return;
    }
    userSettings.apiKey = key;
    userSettings.provider = providerSelect.value;
    updateProviderHint(userSettings.provider);

    try {
      await storage.set({ appSettings: userSettings });
    } catch (err) {
      showStatus(settingsStatus, `儲存失敗:${err.message}`, 'error');
      return;
    }

    showStatus(settingsStatus, `✅ 設定已儲存!目前使用 ${PROVIDERS[userSettings.provider].label}。`, 'info');
    setTimeout(() => {
      settingsPanel.classList.add('hidden');
      $('toggleSettings').setAttribute('aria-expanded', 'false');
      clearStatus(settingsStatus);
    }, 1400);
  });

  // 匯出備份
  $('exportBackupBtn').addEventListener('click', () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), tasks: currentTasks };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `todo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showStatus(backupStatus, '✅ 已匯出備份檔案。', 'info');
    setTimeout(() => clearStatus(backupStatus), 2500);
  });

  // 匯入備份
  $('importBackupBtnLabel').addEventListener('click', () => $('importBackupInput').click());
  $('importBackupInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (Array.isArray(data.tasks) ? data.tasks : null);
      if (!list) throw new Error('檔案格式不正確。');
      const ok = confirm(`即將匯入 ${list.length} 筆任務,並取代目前清單,確定要繼續嗎?`);
      if (!ok) return;
      currentTasks = list.map(migrateTask).filter((t) => t.task);
      await saveAndRender();
      showStatus(backupStatus, `✅ 已匯入 ${currentTasks.length} 筆任務。`, 'info');
    } catch (err) {
      showStatus(backupStatus, `匯入失敗:${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });

  // 送出:按鈕,或在輸入框按 Ctrl/⌘ + Enter
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
      showStatus(statusMsg, '請先點擊右上角「⚙️ 設定」輸入您的 API Key。', 'error');
      openSettings();
      return;
    }
    const providerId = userSettings.provider || 'gemini';

    submitBtn.disabled = true;
    showStatus(statusMsg, `🤖 ${PROVIDERS[providerId].label} 解析中...`, 'info');

    try {
      const raw = await callAI(providerId, userSettings.apiKey, buildParsePrompt(input));
      const newTasks = parseTasks(raw);
      if (newTasks.length === 0) throw new Error('沒有解析出任何任務,請換個說法再試一次。');

      currentTasks = currentTasks.concat(newTasks);
      await saveAndRender();
      taskInput.value = '';
      showStatus(statusMsg, `✅ 已新增 ${newTasks.length} 筆任務。`, 'info');
      setTimeout(() => clearStatus(statusMsg), 2500);
    } catch (error) {
      console.error('發生錯誤詳細資訊:', error);
      showStatus(statusMsg, `連線或處理失敗:${error.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  }
});
