// Small progressive enhancements. Every page works without this file, except the auto-hide of a revealed key.

// Confirm before destructive or important form submits: <form data-confirm="..."> or <button data-confirm="...">.
document.addEventListener('submit', (e) => {
  const message = e.submitter?.dataset.confirm ?? e.target.dataset.confirm;
  if (message && !window.confirm(message)) e.preventDefault();
});

// Revealed key: count down, then wipe it from the page and go back to the computer.
const reveal = document.querySelector('[data-reveal]');
if (reveal) {
  const keyBox = reveal.querySelector('[data-key]');
  const counter = reveal.querySelector('[data-countdown]');
  const back = reveal.dataset.back;
  let left = Number(reveal.dataset.seconds) || 60;

  // Copy to clipboard: the 8 groups, with dashes (the BitLocker recovery screen takes it as is).
  const copyButton = reveal.querySelector('[data-copy-key]');
  let copied = false;
  const keyText = () =>
    [...keyBox.querySelectorAll('.group')].map((g) => g.lastChild.textContent.trim()).join('-');
  copyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyText());
      copied = true;
      copyButton.textContent = 'Đã sao chép ✓';
      window.setTimeout(() => { copyButton.textContent = 'Sao chép key'; }, 2000);
    } catch {
      // No clipboard access (old browser, or not HTTPS): let the user select the key by hand.
      copyButton.textContent = 'Không sao chép được: hãy chọn key và nhấn Ctrl+C';
      window.getSelection()?.selectAllChildren(keyBox);
    }
  });
  // Best effort: do not leave the key in the clipboard once it is hidden here.
  const clearClipboard = () => {
    if (copied) navigator.clipboard?.writeText('').catch(() => {});
  };

  const wipe = () => {
    clearClipboard();
    if (copyButton) copyButton.disabled = true;
    keyBox.textContent = 'Key đã được ẩn.';
    keyBox.classList.add('hidden-key');
    // replace(): the page with the key does not stay in the back/forward history.
    window.location.replace(back);
  };

  const timer = window.setInterval(() => {
    left -= 1;
    counter.textContent = String(left);
    if (left <= 0) {
      window.clearInterval(timer);
      wipe();
    }
  }, 1000);

  reveal.querySelector('[data-hide-now]')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.clearInterval(timer);
    wipe();
  });

  // Leaving the tab hidden for long also wipes the key.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const hiddenAt = Date.now();
      const onShow = () => {
        if (!document.hidden && Date.now() - hiddenAt > left * 1000) wipe();
        document.removeEventListener('visibilitychange', onShow);
      };
      document.addEventListener('visibilitychange', onShow);
    }
  });
}

// Tu dang xuat khi khong hoat dong: server da huy phien sau data-idle-minutes khong co request;
// trang dang mo (vi du trang hien key) cung chuyen ve trang dang nhap, khong de lo noi dung.
(() => {
  const minutes = Number(document.body.dataset.idleMinutes);
  if (!minutes) return;
  setTimeout(() => {
    const next = encodeURIComponent(location.pathname + location.search);
    location.assign(`/login?expired=1&next=${next}`);
  }, minutes * 60_000 + 5_000);
})();

// Form nguoi dung: o "Bat doi mat khau" chi danh cho tai khoan noi bo.
document.querySelectorAll('input[name="authSource"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const box = document.querySelector('[data-local-only] input');
    if (box) box.disabled = radio.value !== 'local' || !radio.checked;
  });
});
