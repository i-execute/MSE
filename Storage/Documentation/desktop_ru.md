# Установка MSE на Desktop (Windows, macOS, Linux)

Данное руководство описывает установку расширения MSE на настольных операционных системах в популярных веб-браузерах.

---

## 1. Поддерживаемые браузеры

MSE совместим со всеми современными десктопными браузерами:
- Google Chrome, Chromium
- Microsoft Edge
- Mozilla Firefox
- Brave Browser, Vivaldi, Opera
- Safari на macOS

---

## 2. Установка менеджера скриптов

Установите менеджер пользовательских скриптов для вашего браузера:

- **Tampermonkey** (рекомендуется для Chrome, Edge, Brave, Firefox):
  - [Tampermonkey для Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
  - [Tampermonkey для Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
  - [Tampermonkey для Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- **Violentmonkey** (альтернативный открытый менеджер с открытым исходным кодом):
  - [Violentmonkey WebStore](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)

---

## 3. Установка скрипта MSE

1. Откройте файл `Storage/artifacts/mse.user.js` в браузере или перетащите его в окно браузера.
2. Менеджер Tampermonkey / Violentmonkey откроет вкладку установки скрипта.
3. Нажмите кнопку **Установить** (Install).
4. Проверьте в панели управления менеджера, что скрипт MSE включен.

---

## 4. Настройка шлюза и горячие клавиши

1. Откройте любую страницу теста в Moodle.
2. В интерфейсе появится пилюля **MSE**.
3. Нажмите на пилюлю для настройки:
   - Введите **Gateway URL** (адрес вашего сервера).
   - Нажмите **Подключиться**.
   - Дождитесь одобрения заявки администратором через Telegram-бота.
4. В десктопной версии поддерживается быстрое взаимодействие:
   - Клик по рекомендуемому варианту ответа мгновенно отмечает чекбокс или радиокнопку в тесте Moodle.
   - При вопросах с множественным выбором можно последовательно кликать по всем вариантам без закрытия меню.
