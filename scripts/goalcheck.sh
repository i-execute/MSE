#!/usr/bin/env bash
F="${1:-GOAL.md}"
[ -f "$F" ] || { echo "нет $F — запусти scripts/init.sh"; exit 2; }
BASE="$(dirname "$F")"

cnt() { [ -z "$1" ] && echo 0 || printf '%s\n' "$1" | grep -c .; }

echo "=== ЦЕЛЬ ==="
goal=$(grep -m1 -E '^Цель:' "$F" || true)
goal_ok=1
if [ -z "$goal" ] || printf '%s' "$goal" | grep -q '<'; then
  echo "(не заполнена! впиши одну фразу в строку «Цель:»)"
  goal_ok=0
else
  echo "$goal"
fi
echo

items=$(grep -E '^[[:space:]]*[-*] \[[ xX!]\]' "$F" || true)
open=$(printf '%s\n' "$items" | grep -E '^[[:space:]]*[-*] \[ \]' || true)
fail=$(printf '%s\n' "$items" | grep -E '^[[:space:]]*[-*] \[!\]' || true)
done_all=$(printf '%s\n' "$items" | grep -E '^[[:space:]]*[-*] \[[xX]\]' || true)

noev=""
broken=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ev=$(printf '%s' "$line" | sed -n 's/.*[Ee]vidence:[[:space:]]*//p')
  if [ -z "$ev" ] || printf '%s' "$ev" | grep -q '<'; then
    noev="${noev}${line}"$'\n'
    continue
  fi
  for p in $(printf '%s' "$ev" | grep -oE 'evidence/[^[:space:],;)`]+' || true); do
    if [ ! -e "$BASE/$p" ] && [ ! -e "$p" ]; then
      broken="${broken}${line}  [нет файла: $p]"$'\n'
    fi
  done
done <<EOT
$done_all
EOT
noev=${noev%$'\n'}
broken=${broken%$'\n'}

ph=$(grep -n -E '<(критерий|одна фраза|что нельзя|как проверить|\.\.\.)' "$F" | grep -v -E '^[0-9]+:Цель:' || true)

n_open=$(cnt "$open"); n_fail=$(cnt "$fail"); n_done=$(cnt "$done_all")
n_noev=$(cnt "$noev"); n_broken=$(cnt "$broken"); n_ph=$(cnt "$ph")

echo "Закрыто: $n_done | Открыто: $n_open | Не удалось: $n_fail | Без evidence: $n_noev | Битый evidence: $n_broken"
echo
[ "$n_open" -gt 0 ] && { echo "--- ОТКРЫТО (работай над этим) ---"; printf '%s\n\n' "$open"; }
[ "$n_noev" -gt 0 ] && { echo "--- ОТМЕЧЕНО БЕЗ EVIDENCE (докажи или сними галочку) ---"; printf '%s\n\n' "$noev"; }
[ "$n_broken" -gt 0 ] && { echo "--- EVIDENCE УКАЗЫВАЕТ НА НЕСУЩЕСТВУЮЩИЙ ФАЙЛ ---"; printf '%s\n\n' "$broken"; }
[ "$n_ph" -gt 0 ] && { echo "--- НЕЗАПОЛНЕННЫЕ ПЛЕЙСХОЛДЕРЫ (замени на реальный текст) ---"; printf '%s\n\n' "$ph"; }
[ "$n_fail" -gt 0 ] && { echo "--- НЕ УДАЛОСЬ (попадёт в отчёт) ---"; printf '%s\n\n' "$fail"; }

if [ "$n_fail" -gt 0 ]; then
  tries=$(grep -c -E '^###.*попытка' "$BASE/ATTEMPTS.md" 2>/dev/null || true)
  tries=${tries:-0}
  need=$((n_fail * 3))
  if [ "$tries" -lt "$need" ]; then
    echo "ВНИМАНИЕ: в ATTEMPTS.md записей о попытках $tries, для $n_fail пунктов «не удалось» нужно минимум $need (по три принципиально разных). Если бюджет не вышел, вернись к этим пунктам."
    echo
  fi
fi

if [ "$n_open" -eq 0 ] && [ "$n_noev" -eq 0 ] && [ "$n_broken" -eq 0 ] && [ "$n_ph" -eq 0 ] && [ "$goal_ok" -eq 1 ] && [ "$n_done" -gt 0 ]; then
  echo "ЧЕКЛИСТ ЗАКРЫТ. Дальше: прогон с нуля, круг скептика, упаковка (references/finish.md)."
  exit 0
fi
echo "НЕ ГОТОВО. Закрой пункты выше. Остановиться можно только если вышел названный бюджет или остался необратимый шаг вне рамок: тогда опиши это в отчёте."
exit 1
