for (const viewer of document.querySelectorAll('[data-source-url]')) {
  const output = viewer.querySelector('[data-source-code]');
  if (!output) continue;

  try {
    const response = await fetch(viewer.dataset.sourceUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    output.textContent = await response.text();
  } catch (error) {
    output.textContent = `Não foi possível carregar o arquivo: ${error.message}`;
  }
}
