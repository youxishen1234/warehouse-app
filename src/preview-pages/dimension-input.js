(function () {
  const cartonFields = new Set(['s-size', 'cb-carton', 'ci-size']);
  const boardFields = new Set(['sp-size']);

  function normalizeSeparators(value) {
    return String(value ?? '').replace(/[xX*＊✕]/g, '×').replace(/\s+/g, '');
  }

  function isBoardContext(input) {
    if (boardFields.has(input.id)) return true;
    if (input.id === 's-size') return /纸板|纸卡|楞纸|楞板|瓦楞/.test(document.getElementById('s-name')?.value || '');
    if (input.dataset.k === 'spec') {
      return /纸板|纸卡|楞纸|楞板|瓦楞/.test(input.closest('.manual-line')?.querySelector('[data-k="goods"]')?.value || '');
    }
    return false;
  }

  function format(value, digits, maxGroups) {
    const normalized = normalizeSeparators(value);
    const suffixMatch = normalized.match(/(cm|mm)$/i);
    const suffix = suffixMatch ? suffixMatch[0] : '';
    const numberPart = suffix ? normalized.slice(0, -suffix.length) : normalized;
    if (!numberPart || !/^[0-9×]+$/.test(numberPart)) return value;

    const groups = numberPart.replace(/×/g, '').match(new RegExp(`.{1,${digits}}`, 'g')) || [];
    if (digits === 3 && groups.length > 1 && groups[1].length === 3 && groups[1][0] === '0') {
      groups[1] = String(Number(groups[1]));
    }

    let result = groups.join('×');
    const lastGroup = groups[groups.length - 1] || '';
    if (groups.length < maxGroups && lastGroup.length === digits) result += '×';
    return result + suffix;
  }

  function caretAfterDigits(value, digitCount) {
    if (digitCount <= 0) return 0;
    let seen = 0;
    let index = 0;
    while (index < value.length && seen < digitCount) {
      if (/\d/.test(value[index])) seen += 1;
      index += 1;
    }
    if (value[index] === '×') index += 1;
    return index;
  }

  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!cartonFields.has(input.id) && !boardFields.has(input.id) && input.dataset.k !== 'spec') return;

    const digits = isBoardContext(input) ? 3 : 2;
    const maxGroups = digits === 3 ? 2 : 3;
    const selectionStart = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = input.value.slice(0, selectionStart).replace(/\D/g, '').length;
    const formatted = format(input.value, digits, maxGroups);
    if (formatted === input.value) return;

    input.value = formatted;
    const caret = caretAfterDigits(formatted, digitsBeforeCaret);
    input.setSelectionRange(caret, caret);
  });

  window.DimensionInput = { format };
})();
