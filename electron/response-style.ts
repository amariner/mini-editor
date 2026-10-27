/** Presentation preference for this turn only; never changes the visible user message. */
export function responsePrompt(text: string, style?: 'study') {
  if (style !== 'study') return text;
  return `${text || 'Revisa los archivos adjuntos.'}

<response_style>
Solo para esta petición: presenta la respuesta final como un esquema de estudio que facilite la concentración. Usa puntos breves, una idea por punto y, cuando sirva, una secuencia de pasos. Evita introducciones y cierres redundantes. Marca con **negrita** uno o dos conceptos clave por punto; la interfaz los subrayará. No destaques frases enteras. Conserva los matices, datos, fórmulas y ejemplos necesarios para comprender: no sacrifiques exactitud por brevedad. Respeta el idioma y cualquier formato específico solicitado por el usuario, incluidos código, traducciones y textos literales. Esta preferencia solo afecta a la presentación, no a las herramientas ni a los permisos, y no se aplica a turnos posteriores.
</response_style>`;
}
