type ToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Browser list/new return state directly; only an explicit failure is an error. */
export function coordinationToolResult(result: unknown, transportOK = true) {
  const value = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const isError = !transportOK || value.ok === false;
  const { image, mimeType, ...metadata } = value;
  const content: ToolContent[] = [];
  if (
    !isError &&
    typeof image === 'string' &&
    typeof mimeType === 'string' &&
    /^image\/(png|jpeg|webp|gif)$/.test(mimeType)
  ) {
    content.push({ type: 'text', text: JSON.stringify(metadata) });
    content.push({ type: 'image', data: image, mimeType });
  } else {
    content.push({
      type: 'text',
      text: JSON.stringify('image' in value ? metadata : result) ?? 'null',
    });
  }
  return { content, isError };
}
