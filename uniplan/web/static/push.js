// "Turn on notifications" button on the Health page.
(() => {
  const btn = document.getElementById('push-enable');
  if (!btn) return;
  const status = document.getElementById('push-status');
  const say = (text, bad) => { status.textContent = text; status.className = 'text-xs ' + (bad ? 'text-rose-400' : 'text-emerald-400'); };
  const toBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) {
    btn.disabled = true;
    say('Open UniPlan from your home-screen icon to turn these on.', true);
    return;
  }

  navigator.serviceWorker.getRegistration('/').then(async reg => {
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { btn.textContent = 'Reconnect notifications'; say('On for this device.'); }
  });

  btn.addEventListener('click', async () => {
    try {
      // iOS only allows this prompt directly from a tap, so it has to come first.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return say('Notifications are blocked. Allow them in iOS Settings → Notifications → UniPlan.', true);
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: toBytes(btn.dataset.key) });
      const r = await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify(sub.toJSON()) });
      if (!r.ok) throw new Error(`server said ${r.status}`);
      btn.textContent = 'Reconnect notifications';
      say('On for this device.');
    } catch (e) {
      say(`Could not turn on notifications: ${e.message}`, true);
    }
  });
})();
