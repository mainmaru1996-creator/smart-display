<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#000000">
<title>卓上ディスプレイ</title>
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="css/style.css">
</head>
<body>
  <button id="settings-button" class="icon-button" aria-label="設定">⚙</button>

  <main class="dashboard">
    <section class="clock">
      <div id="clock-time" class="clock-time">--:--</div>
      <div id="clock-date" class="clock-date">----年--月--日</div>
    </section>

    <section class="panels">
      <div class="panel calendar">
        <h2 id="calendar-title" class="panel-title">カレンダー</h2>
        <div id="calendar-grid" class="calendar-grid"></div>
      </div>

      <div class="panel weather">
        <h2 class="panel-title">天気</h2>
        <div id="weather-location" class="weather-location">--</div>
        <div id="weather-temp" class="weather-temp">--°C</div>
        <div id="weather-desc" class="weather-desc">読み込み中...</div>
        <div id="weather-forecast" class="weather-forecast"></div>
      </div>
    </section>
  </main>

  <div id="settings-modal" class="modal hidden">
    <div class="modal-content">
      <h2>設定</h2>
      <label for="location-input">天気を表示する地域名</label>
      <input id="location-input" type="text" placeholder="例: 東京">
      <div id="settings-error" class="settings-error"></div>
      <div class="modal-actions">
        <button id="settings-cancel" type="button">キャンセル</button>
        <button id="settings-save" type="button">保存</button>
      </div>
    </div>
  </div>

  <script type="module" src="js/app.js"></script>
</body>
</html>
