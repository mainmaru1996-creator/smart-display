import { getLocation, setLocation, geocodeCityName, updateWeather } from './weather.js';

export function setupSettings() {
  const button = document.getElementById('settings-button');
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('location-input');
  const errorEl = document.getElementById('settings-error');
  const cancelButton = document.getElementById('settings-cancel');
  const saveButton = document.getElementById('settings-save');

  function openModal() {
    input.value = getLocation().name;
    errorEl.textContent = '';
    modal.classList.remove('hidden');
    input.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  async function save() {
    const cityName = input.value.trim();
    if (!cityName) {
      errorEl.textContent = '地域名を入力してください';
      return;
    }
    saveButton.disabled = true;
    errorEl.textContent = '検索中...';
    try {
      const location = await geocodeCityName(cityName);
      setLocation(location);
      await updateWeather();
      closeModal();
    } catch {
      errorEl.textContent = '地域が見つかりませんでした';
    } finally {
      saveButton.disabled = false;
    }
  }

  button.addEventListener('click', openModal);
  cancelButton.addEventListener('click', closeModal);
  saveButton.addEventListener('click', save);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
}
