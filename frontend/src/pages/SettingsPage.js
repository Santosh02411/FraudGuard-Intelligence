import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth } from '../context/AuthContext';
import {
  UserCog, KeyRound, Mail, ShieldCheck, ShieldOff, CheckCircle, AlertTriangle,
  Copy, RefreshCw, Plus, Trash2, Webhook, Code2, Eye, Download,
} from 'lucide-react';
import { downloadJson } from '../utils/download';

const inputClass = "w-full bg-[#0a0f14] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";
const labelClass = "block text-sm text-gray-300 mb-1";

function Card({ icon: Icon, title, description, children }) {
  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-5 sm:p-6">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={18} className="text-purple-400" />
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {description && <p className="text-gray-500 text-sm mb-4">{description}</p>}
      {children}
    </div>
  );
}

function describeError(err, fallback) {
  const data = err.response?.data;
  if (data?.details?.length) return data.details.map(d => d.message).join(' ');
  return data?.error || fallback;
}

function ChangePasswordCard() {
  const { applyNewTokens } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (form.newPassword !== form.confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.patch('/auth/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      // The backend revoked every refresh token for this account
      // (including the one this session was using) and issued a fresh
      // pair — store it, or the next access-token expiry would try to
      // refresh with a now-dead token and force an unwanted logout.
      applyNewTokens(data);
      setSuccess('Password changed successfully. Your other devices have been signed out.');
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setError(describeError(err, 'Failed to change password'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card icon={KeyRound} title="Change Password" description="Changing your password signs you out of every other session.">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className={labelClass}>Current password</label>
          <input type="password" value={form.currentPassword} onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} className={inputClass} required />
        </div>
        <div>
          <label className={labelClass}>New password</label>
          <input type="password" value={form.newPassword} onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} className={inputClass} required />
        </div>
        <div>
          <label className={labelClass}>Confirm new password</label>
          <input type="password" value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} className={inputClass} required />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {success && <p className="text-green-400 text-sm">{success}</p>}
        <button type="submit" disabled={loading} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          {loading ? 'Changing...' : 'Change Password'}
        </button>
      </form>
    </Card>
  );
}

function ChangeEmailCard({ user, onUpdated }) {
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const { data } = await api.patch('/auth/email', { newEmail, currentPassword });
      setSuccess(data.message);
      setNewEmail('');
      setCurrentPassword('');
      onUpdated(data.user);
    } catch (err) {
      setError(describeError(err, 'Failed to change email'));
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    setResending(true);
    setResendMsg('');
    try {
      const { data } = await api.post('/auth/resend-verification');
      setResendMsg(data.message);
    } catch (err) {
      setResendMsg(describeError(err, 'Failed to resend verification email'));
    } finally {
      setResending(false);
    }
  };

  return (
    <Card icon={Mail} title="Email Address" description="Changing your email requires re-verifying the new address.">
      <div className="flex items-center gap-2 mb-4 text-sm">
        <span className="text-gray-400">Current:</span>
        <span className="text-white">{user.email}</span>
        {user.email_verified ? (
          <span className="flex items-center gap-1 text-green-400 text-xs"><CheckCircle size={12} /> Verified</span>
        ) : (
          <span className="flex items-center gap-1 text-yellow-400 text-xs"><AlertTriangle size={12} /> Not verified</span>
        )}
      </div>

      {!user.email_verified && (
        <div className="mb-4">
          <button
            onClick={resendVerification}
            disabled={resending}
            className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 transition-colors"
          >
            {resending ? 'Sending...' : 'Resend verification email'}
          </button>
          {resendMsg && <p className="text-gray-500 text-xs mt-1">{resendMsg}</p>}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className={labelClass}>New email</label>
          <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className={inputClass} placeholder="new@example.com" required />
        </div>
        <div>
          <label className={labelClass}>Current password</label>
          <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className={inputClass} required />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {success && <p className="text-green-400 text-sm">{success}</p>}
        <button type="submit" disabled={loading} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          {loading ? 'Updating...' : 'Update Email'}
        </button>
      </form>
    </Card>
  );
}

function MfaCard({ user, onUpdated }) {
  const { applyNewTokens } = useAuth();
  const [step, setStep] = useState('idle'); // idle | setup | enabled_confirm | disable
  const [setupData, setSetupData] = useState(null); // { secret, otpauthUrl, qrCodeDataUrl }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const startSetup = async () => {
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/mfa/setup');
      setSetupData(data);
      setStep('setup');
    } catch (err) {
      setError(describeError(err, 'Failed to start 2FA setup'));
    } finally {
      setLoading(false);
    }
  };

  const confirmEnable = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/mfa/enable', { code });
      // /mfa/enable revokes every refresh token for the account
      // (including this session's) and issues a fresh pair for this
      // session — store it, same reasoning as the password-change flow.
      applyNewTokens(data);
      setBackupCodes(data.backupCodes);
      setStep('enabled_confirm');
      onUpdated({ totp_enabled: 1 });
    } catch (err) {
      setError(describeError(err, 'Invalid code'));
    } finally {
      setLoading(false);
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/mfa/disable', { password: disablePassword });
      onUpdated({ totp_enabled: 0 });
      setStep('idle');
      setDisablePassword('');
    } catch (err) {
      setError(describeError(err, 'Failed to disable 2FA'));
    } finally {
      setLoading(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard?.writeText(setupData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const finishEnabledConfirm = () => {
    setStep('idle');
    setSetupData(null);
    setCode('');
    setBackupCodes(null);
  };

  return (
    <Card icon={ShieldCheck} title="Two-Factor Authentication" description="Add an authenticator-app code to your login, on top of your password.">
      {step === 'enabled_confirm' && backupCodes ? (
        <div>
          <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg px-4 py-3 text-sm mb-4">
            Two-factor authentication is now enabled.
          </div>
          <p className="text-yellow-400 text-sm mb-2 flex items-center gap-1"><AlertTriangle size={14} /> Save these backup codes — they won't be shown again.</p>
          <div className="bg-black/30 rounded-lg p-4 grid grid-cols-2 gap-2 font-mono text-sm text-gray-200 mb-4">
            {backupCodes.map(c => <span key={c}>{c}</span>)}
          </div>
          <button onClick={finishEnabledConfirm} className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            Done
          </button>
        </div>
      ) : user.totp_enabled ? (
        step === 'disable' ? (
          <form onSubmit={disable} className="space-y-3">
            <p className="text-gray-400 text-sm">Enter your password to disable two-factor authentication.</p>
            <input type="password" value={disablePassword} onChange={e => setDisablePassword(e.target.value)} className={inputClass} placeholder="Current password" required />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex items-center gap-2">
              <button type="submit" disabled={loading} className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                {loading ? 'Disabling...' : 'Disable 2FA'}
              </button>
              <button type="button" onClick={() => { setStep('idle'); setError(''); }} className="text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p className="flex items-center gap-2 text-green-400 text-sm mb-3"><ShieldCheck size={16} /> Two-factor authentication is enabled.</p>
            <button onClick={() => setStep('disable')} className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors">
              <ShieldOff size={14} /> Disable 2FA
            </button>
          </div>
        )
      ) : step === 'setup' && setupData ? (
        <form onSubmit={confirmEnable} className="space-y-4">
          <p className="text-gray-400 text-sm">Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</p>
          <img src={setupData.qrCodeDataUrl} alt="Two-factor authentication QR code" className="mx-auto rounded-lg border border-white/10" width={200} height={200} />
          <div className="text-center">
            <p className="text-gray-500 text-xs mb-1">Or enter this code manually:</p>
            <button type="button" onClick={copySecret} className="inline-flex items-center gap-2 font-mono text-sm text-purple-300 bg-black/30 rounded-lg px-3 py-1.5">
              {setupData.secret} <Copy size={12} />
            </button>
            {copied && <p className="text-green-400 text-xs mt-1">Copied!</p>}
          </div>
          <div>
            <label className={labelClass}>6-digit code</label>
            <input
              type="text" inputMode="numeric" value={code}
              onChange={e => setCode(e.target.value.trim())}
              className={`${inputClass} text-center tracking-[0.3em]`}
              placeholder="123456" maxLength={6} required
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={loading} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {loading ? 'Verifying...' : 'Enable 2FA'}
            </button>
            <button type="button" onClick={() => { setStep('idle'); setSetupData(null); setError(''); }} className="text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <p className="flex items-center gap-2 text-gray-500 text-sm mb-3"><ShieldOff size={16} /> Two-factor authentication is not enabled.</p>
          {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
          <button onClick={startSetup} disabled={loading} className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            {loading ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Set Up 2FA
          </button>
        </div>
      )}
    </Card>
  );
}

function ApiKeysCard() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState(null); // { key, prefix, ... } shown once after creation

  const load = () => {
    setLoading(true);
    api.get('/api-keys').then(({ data }) => setKeys(data.apiKeys)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const { data } = await api.post('/api-keys', { name });
      setNewKey(data);
      setName('');
      load();
    } catch (err) {
      setError(describeError(err, 'Failed to create API key'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    await api.delete(`/api-keys/${id}`);
    load();
  };

  const copyKey = () => navigator.clipboard?.writeText(newKey.key);

  return (
    <Card icon={Code2} title="API Keys" description="Credentials for a service integration (e.g. your own backend calling this API) — not tied to your password.">
      {newKey && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 mb-4">
          <p className="text-green-400 text-sm font-medium mb-2">API key created — copy it now, it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/30 rounded px-3 py-2 text-xs text-gray-200 break-all">{newKey.key}</code>
            <button onClick={copyKey} className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 shrink-0 transition-colors"><Copy size={14} /></button>
          </div>
          <button onClick={() => setNewKey(null)} className="text-gray-400 hover:text-white text-xs mt-2 transition-colors">Dismiss</button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : keys.length === 0 ? (
        <p className="text-gray-500 text-sm mb-4">No API keys yet.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {keys.map(k => (
            <div key={k.id} className="flex items-center justify-between bg-black/20 rounded-lg px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-white truncate">{k.name}</p>
                <p className="text-gray-500 text-xs">
                  <code>{k.key_prefix}...</code> &middot; {k.scopes.join(', ')}
                  {k.revoked_at ? <span className="text-red-400"> &middot; revoked</span> : k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : ' · never used'}
                </p>
              </div>
              {!k.revoked_at && (
                <button onClick={() => revoke(k.id)} className="p-2 text-gray-400 hover:text-red-400 shrink-0 transition-colors" title="Revoke">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={create} className="flex items-end gap-2">
        <div className="flex-1">
          <label className={labelClass}>New key name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputClass} placeholder="e.g. Production Backend" required />
        </div>
        <button type="submit" disabled={creating} className="flex items-center gap-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shrink-0">
          <Plus size={14} /> Create
        </button>
      </form>
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
    </Card>
  );
}

// Kept in sync with backend/schemas/webhookSchemas.js's EVENTS enum.
// '*' subscribes to everything this app fires.
const WEBHOOK_EVENTS = [
  { value: 'transaction.flagged', label: 'Transaction flagged', hint: 'Fires on every medium/high-risk transaction.' },
  { value: 'transaction.step_up_required', label: 'Step-up required', hint: 'Opts a medium-risk transaction INTO being held for your own OTP/3DS flow instead of completing immediately — see the Simulator.' },
  { value: 'transaction.step_up_verified', label: 'Step-up verified', hint: 'Fires once you resolve a held transaction as verified.' },
  { value: 'transaction.step_up_failed', label: 'Step-up failed', hint: 'Fires once you resolve a held transaction as failed.' },
  { value: '*', label: 'All events (wildcard)', hint: 'Subscribes to every event above, including future ones.' },
];

function EventCheckboxes({ selected, onChange }) {
  const toggle = (value) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };
  return (
    <div className="space-y-2">
      {WEBHOOK_EVENTS.map(ev => (
        <label key={ev.value} className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(ev.value)}
            onChange={() => toggle(ev.value)}
            className="mt-0.5 accent-purple-600"
          />
          <span>
            <span className="text-sm text-gray-200 block">{ev.label}</span>
            <span className="text-xs text-gray-500">{ev.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function WebhooksCard() {
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(['transaction.flagged']);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [newWebhook, setNewWebhook] = useState(null); // shows secret once
  const [deliveriesFor, setDeliveriesFor] = useState(null);
  const [deliveries, setDeliveries] = useState([]);

  // Editing an existing webhook's event subscriptions (feature: step-up
  // authentication is otherwise unreachable — a webhook created before
  // this existed, or through the old url-only form, can only ever get
  // transaction.flagged without this).
  const [editingId, setEditingId] = useState(null);
  const [editEvents, setEditEvents] = useState([]);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/webhooks').then(({ data }) => setWebhooks(data.webhooks)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const { data } = await api.post('/webhooks', { url, events });
      setNewWebhook(data);
      setUrl('');
      setEvents(['transaction.flagged']);
      load();
    } catch (err) {
      setError(describeError(err, 'Failed to create webhook'));
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (webhook) => {
    await api.patch(`/webhooks/${webhook.id}`, { active: !webhook.active });
    load();
  };

  const remove = async (id) => {
    await api.delete(`/webhooks/${id}`);
    load();
  };

  const viewDeliveries = async (id) => {
    setDeliveriesFor(id);
    const { data } = await api.get(`/webhooks/${id}/deliveries`);
    setDeliveries(data.deliveries);
  };

  const startEditingEvents = (webhook) => {
    setEditingId(webhook.id);
    setEditEvents(webhook.events);
    setEditError('');
  };

  const saveEvents = async (id) => {
    setEditSaving(true);
    setEditError('');
    try {
      await api.patch(`/webhooks/${id}`, { events: editEvents });
      setEditingId(null);
      load();
    } catch (err) {
      setEditError(describeError(err, 'Failed to update events'));
    } finally {
      setEditSaving(false);
    }
  };

  const copySecret = () => navigator.clipboard?.writeText(newWebhook.secret);

  return (
    <Card icon={Webhook} title="Webhooks" description="Get a signed HTTP callback whenever one of your transactions is flagged, or opt into the step-up hold-and-verify flow.">
      {newWebhook && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 mb-4">
          <p className="text-green-400 text-sm font-medium mb-2">Webhook created — save this signing secret now, it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/30 rounded px-3 py-2 text-xs text-gray-200 break-all">{newWebhook.secret}</code>
            <button onClick={copySecret} className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 shrink-0 transition-colors"><Copy size={14} /></button>
          </div>
          <p className="text-gray-500 text-xs mt-2">Use it to verify the <code>X-FraudGuard-Signature</code> header on every delivery.</p>
          <button onClick={() => setNewWebhook(null)} className="text-gray-400 hover:text-white text-xs mt-2 transition-colors">Dismiss</button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : webhooks.length === 0 ? (
        <p className="text-gray-500 text-sm mb-4">No webhooks yet.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {webhooks.map(w => (
            <div key={w.id}>
              <div className="flex items-center justify-between bg-black/20 rounded-lg px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="text-white truncate">{w.url}</p>
                  <p className="text-gray-500 text-xs">{w.events.join(', ')} &middot; {w.active ? <span className="text-green-400">active</span> : <span className="text-gray-500">paused</span>}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => (editingId === w.id ? setEditingId(null) : startEditingEvents(w))} className="p-2 text-gray-400 hover:text-white transition-colors" title="Edit event subscriptions"><Code2 size={14} /></button>
                  <button onClick={() => viewDeliveries(w.id)} className="p-2 text-gray-400 hover:text-white transition-colors" title="View deliveries"><Eye size={14} /></button>
                  <button onClick={() => toggleActive(w)} className="p-2 text-gray-400 hover:text-white transition-colors" title={w.active ? 'Pause' : 'Activate'}>
                    {w.active ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                  </button>
                  <button onClick={() => remove(w.id)} className="p-2 text-gray-400 hover:text-red-400 transition-colors" title="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
              {editingId === w.id && (
                <div className="mt-2 ml-3 border-l border-white/10 pl-3 py-2">
                  <EventCheckboxes selected={editEvents} onChange={setEditEvents} />
                  {editError && <p className="text-red-400 text-xs mt-2">{editError}</p>}
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => saveEvents(w.id)}
                      disabled={editSaving || editEvents.length === 0}
                      className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    >
                      {editSaving ? 'Saving...' : 'Save events'}
                    </button>
                    <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-white text-xs px-2 transition-colors">Cancel</button>
                  </div>
                </div>
              )}
              {deliveriesFor === w.id && (
                <div className="mt-2 ml-3 border-l border-white/10 pl-3 space-y-1">
                  {deliveries.length === 0 ? (
                    <p className="text-gray-500 text-xs">No deliveries yet.</p>
                  ) : deliveries.map(d => (
                    <p key={d.id} className="text-xs">
                      <span className={d.success ? 'text-green-400' : 'text-red-400'}>{d.success ? '✓' : '✗'}</span>{' '}
                      <span className="text-gray-400">{new Date(d.created_at).toLocaleString()}</span>{' '}
                      <span className="text-gray-500">— {d.response_status ?? d.error ?? 'no response'} (attempt {d.attempt})</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={create}>
        <div className="mb-3">
          <label className={labelClass}>New webhook URL</label>
          <input type="url" value={url} onChange={e => setUrl(e.target.value)} className={inputClass} placeholder="https://your-app.example.com/fraudguard-hook" required />
        </div>
        <div className="mb-3">
          <label className={labelClass}>Events</label>
          <EventCheckboxes selected={events} onChange={setEvents} />
        </div>
        <button
          type="submit"
          disabled={creating || events.length === 0}
          className="flex items-center gap-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={14} /> Add Webhook
        </button>
      </form>
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
    </Card>
  );
}

function DataPrivacyCard() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const exportData = async () => {
    setExportError('');
    setExporting(true);
    try {
      const { data } = await api.get('/auth/me/export');
      downloadJson(data, `fraudguard-data-export-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) {
      setExportError('Failed to export your data');
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async (e) => {
    e.preventDefault();
    setDeleteError('');
    setDeleting(true);
    try {
      await api.delete('/auth/me', { data: { password: deletePassword } });
      logout();
      navigate('/login');
    } catch (err) {
      setDeleteError(describeError(err, 'Failed to delete account'));
      setDeleting(false);
    }
  };

  return (
    <Card icon={Download} title="Your Data" description="Download everything this app holds about your account, or close it entirely.">
      <div className="mb-6">
        <button
          onClick={exportData}
          disabled={exporting}
          className="flex items-center gap-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Download size={14} /> {exporting ? 'Preparing export...' : 'Export My Data (JSON)'}
        </button>
        {exportError && <p className="text-red-400 text-sm mt-2">{exportError}</p>}
      </div>

      <div className="border-t border-red-500/20 pt-5">
        <p className="text-red-400 text-sm font-semibold mb-1">Danger Zone</p>
        {!showDeleteConfirm ? (
          <>
            <p className="text-gray-500 text-sm mb-3">
              Deleting your account removes your login and personal details. Your transaction and alert history is
              kept, disconnected from your identity, for fraud-prevention purposes.
            </p>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-2 bg-red-600/10 hover:bg-red-600/20 text-red-400 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Trash2 size={14} /> Delete My Account
            </button>
          </>
        ) : (
          <form onSubmit={deleteAccount} className="space-y-3">
            <p className="text-gray-300 text-sm">Enter your password to permanently delete your account. This cannot be undone.</p>
            <input
              type="password"
              value={deletePassword}
              onChange={e => setDeletePassword(e.target.value)}
              className={inputClass}
              placeholder="Current password"
              required
            />
            {deleteError && <p className="text-red-400 text-sm">{deleteError}</p>}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {deleting ? 'Deleting...' : 'Permanently Delete My Account'}
              </button>
              <button
                type="button"
                onClick={() => { setShowDeleteConfirm(false); setDeletePassword(''); setDeleteError(''); }}
                className="text-gray-400 hover:text-white text-sm px-3 py-2 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [localUser, setLocalUser] = useState(user);

  const applyUpdate = (patch) => {
    const merged = { ...localUser, ...patch };
    setLocalUser(merged);
    refreshUser().catch(() => {}); // best-effort sync of the shared auth context; local state above already reflects the change
  };

  if (!localUser) return null;

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="mb-6 sm:mb-8 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-purple-500/15 flex items-center justify-center shrink-0">
          <UserCog size={22} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Account Settings</h1>
          <p className="text-gray-400 mt-1 text-sm sm:text-base">Manage your password, email, two-factor authentication, API keys, and webhooks.</p>
        </div>
      </div>

      <div className="space-y-6">
        <ChangePasswordCard />
        <ChangeEmailCard user={localUser} onUpdated={applyUpdate} />
        <MfaCard user={localUser} onUpdated={applyUpdate} />
        <ApiKeysCard />
        <WebhooksCard />
        <DataPrivacyCard />
      </div>
    </div>
  );
}
