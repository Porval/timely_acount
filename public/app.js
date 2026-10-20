const $ = (id) => document.getElementById(id);
let current = null;
let accounts = [];
let editingId = null;
let countdown = null;
let toastTimer;
let refreshing = false;
function toast(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function showLogin(message = '') {
  current = null;
  $('workspace').hidden = true;
  $('login-view').hidden = false;
  $('login-code').value = '';
  $('login-message').textContent = message;
  if ($('account-dialog').open) $('account-dialog').close();
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && current) showLogin(result.error);
    throw new Error(result.error || '请求失败');
  }
  return result;
}
const post = (path, body) => api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function renderAccounts() {
  $('total-count').textContent = accounts.length;
  $('enabled-count').textContent = accounts.filter((a) => a.enabled).length;
  $('provider-count').textContent = new Set(accounts.map((a) => a.providerName)).size;
  const search = $('search').value.trim().toLowerCase();
  const status = $('status-filter').value;
  const shown = accounts.filter((a) => `${a.providerName} ${a.personName} ${a.mobile}`.toLowerCase().includes(search) &&
    (status === 'all' || a.enabled === (status === 'enabled')));
  $('account-rows').replaceChildren();
  for (const account of shown) {
    const row = document.createElement('tr');
    row.append(cell(account.personName), cell(account.providerName), cell(account.mobile), cell(account.role === 'admin' ? '管理员' : '普通成员'));
    const statusCell = cell('');
    const pill = document.createElement('span');
    pill.className = `pill${account.enabled ? '' : ' disabled'}`;
    pill.textContent = account.enabled ? '已启用' : '已停用';
    statusCell.append(pill);
    const actions = cell('');
    const edit = document.createElement('button');
    edit.textContent = '编辑'; edit.addEventListener('click', () => openAccount(account));
    const toggle = document.createElement('button');
    toggle.className = account.enabled ? 'stop' : '';
    toggle.textContent = account.enabled ? '停用' : '启用';
    toggle.addEventListener('click', async () => {
      if (account.enabled && !window.confirm(`停用 ${account.personName} 的账户？停用后将立即退出登录。`)) return;
      toggle.disabled = true;
      try {
        await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !account.enabled }) });
        toast(account.enabled ? '账户已停用' : '账户已启用');
        await refreshSession();
      } catch (error) { toast(error.message); toggle.disabled = false; }
    });
    actions.append(edit, toggle); row.append(statusCell, actions); $('account-rows').append(row);
  }
  $('empty-state').hidden = shown.length !== 0;
  $('table-count').textContent = `显示 ${shown.length} 个账户，共 ${accounts.length} 个`;
}
async function renderWorkspace(result) {
  current = result.account;
  const admin = current.role === 'admin';
  $('login-view').hidden = true; $('workspace').hidden = false;
  $('current-name').textContent = current.personName;
  $('current-role').textContent = admin ? '管理员' : '普通成员';
  $('nav-label').textContent = admin ? '账户管理' : '我的账户';
  $('page-title').textContent = admin ? '账户管理' : '我的账户';
  $('page-subtitle').textContent = admin ? '管理服务商与人员信息，维护后台访问权限。' : '查看你所属的服务商及账户资料。';
  $('session-expiry').textContent = new Date(result.expiresAt).toLocaleString('zh-CN', { hour12: false });
  $('admin-view').hidden = !admin; $('member-view').hidden = admin; $('add-account').hidden = !admin;
  if (admin) {
    accounts = (await api('/api/accounts')).accounts;
    renderAccounts();
  } else {
    $('profile-fields').replaceChildren();
    for (const [label, value] of [['服务商名称', current.providerName], ['人员名称', current.personName], ['手机号', current.mobile]]) {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      $('profile-fields').append(dt, dd);
    }
  }
}
async function refreshSession() {
  if (refreshing) return;
  refreshing = true;
  try { await renderWorkspace(await api('/api/auth/me')); }
  catch (error) { if (current) toast(error.message); }
  finally { refreshing = false; }
}
function openAccount(account) {
  editingId = account?.id || null;
  $('account-form').reset();
  $('dialog-title').textContent = account ? '编辑账户' : '新增账户';
  $('account-message').textContent = '';
  for (const key of ['providerName', 'personName', 'mobile', 'role']) if (account) $('account-form').elements[key].value = account[key];
  $('account-dialog').showModal();
}
$('send-code').addEventListener('click', async () => {
  if (!$('login-mobile').reportValidity()) return;
  const button = $('send-code'); button.disabled = true;
  $('login-message').textContent = '';
  try {
    const result = await post('/api/auth/code', { mobile: $('login-mobile').value.trim() });
    $('login-message').textContent = result.message;
    if (result.devCode) {
      $('development-code').textContent = `本次开发验证码：${result.devCode}（5 分钟有效）`;
      $('login-code').value = result.devCode;
    }
    let remaining = result.retryAfter;
    button.textContent = `${remaining} 秒后重试`;
    clearInterval(countdown);
    countdown = setInterval(() => {
      remaining--; button.textContent = `${remaining} 秒后重试`;
      if (remaining <= 0) { clearInterval(countdown); button.disabled = false; button.textContent = '获取验证码'; }
    }, 1000);
    $('login-code').focus();
  } catch (error) { $('login-message').textContent = error.message; button.disabled = false; }
});
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('login-submit').disabled = true; $('login-message').textContent = '';
  try {
    const result = await post('/api/auth/login', { mobile: $('login-mobile').value.trim(), code: $('login-code').value.trim() });
    await renderWorkspace(result);
    $('development-code').textContent = '开发模式 · 验证码未发送到真实手机';
  } catch (error) { $('login-message').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await post('/api/auth/logout'); showLogin(); toast('已退出登录'); }
  catch (error) { toast(error.message); }
});
$('add-account').addEventListener('click', () => openAccount());
$('search').addEventListener('input', renderAccounts);
$('status-filter').addEventListener('change', renderAccounts);
for (const id of ['dialog-close', 'dialog-cancel']) $(id).addEventListener('click', () => $('account-dialog').close());
$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('account-save').disabled = true; $('account-message').textContent = '';
  const values = Object.fromEntries(new FormData(event.target));
  try {
    if (editingId) await api(`/api/accounts/${editingId}`, { method: 'PATCH', body: JSON.stringify(values) });
    else await post('/api/accounts', values);
    $('account-dialog').close(); toast('账户已保存'); await refreshSession();
  } catch (error) { $('account-message').textContent = error.message; }
  finally { $('account-save').disabled = false; }
});
window.addEventListener('focus', () => { if (current) refreshSession(); });
setInterval(() => { if (current && !document.hidden) refreshSession(); }, 30000);
(async () => {
  try {
    const config = await api('/api/config');
    $('development-note').hidden = !config.developmentSms;
    if (config.developmentSms) $('login-mobile').value = '13800138000';
    await refreshSession();
  } catch (error) { $('login-message').textContent = error.message; }
})();
