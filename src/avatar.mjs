// A Grok Bot's avatar for Persona's Agents tab: its own picture when it has one, else its Grok Bot character
// (the shape and colour the SDK derives, vendor/grok-bot-sdk/avatar.mjs) drawn as a small SVG. The hub decodes
// data: URLs and rasterizes SVG (agents/avatar.go), path-based shapes only: no text.

const BODIES = {
  hex: '<polygon points="32,4 57,18 57,46 32,60 7,46 7,18"/>',
  gem: '<polygon points="32,4 57,18 57,46 32,60 7,46 7,18"/>',
  crystal: '<polygon points="32,3 54,22 44,60 20,60 10,22"/>',
  squircle: '<rect x="6" y="6" width="52" height="52" rx="18"/>',
  square: '<rect x="7" y="7" width="50" height="50" rx="10"/>',
  tablet: '<rect x="10" y="4" width="44" height="56" rx="14"/>',
  capsule: '<rect x="12" y="4" width="40" height="56" rx="20"/>',
  cylinder: '<rect x="10" y="6" width="44" height="52" rx="12"/>',
  wedge: '<path d="M32 4 Q35 4 37 8 L59 52 Q61 60 53 60 L11 60 Q3 60 5 52 L27 8 Q29 4 32 4 Z"/>',
  shield: '<path d="M32 4 L56 12 L56 30 Q56 50 32 60 Q8 50 8 30 L8 12 Z"/>',
  arch: '<path d="M8 60 L8 30 A24 24 0 0 1 56 30 L56 60 Z"/>',
  dome: '<path d="M4 54 L4 38 A28 28 0 0 1 60 38 L60 54 Q60 60 54 60 L10 60 Q4 60 4 54 Z"/>',
  teardrop: '<path d="M32 4 C40 16 56 28 56 42 A24 24 0 0 1 8 42 C8 28 24 16 32 4 Z"/>',
  leaf: '<path d="M32 4 C40 16 56 28 56 42 A24 24 0 0 1 8 42 C8 28 24 16 32 4 Z"/>',
  cloud: '<path d="M16 54 A12 12 0 0 1 14 30 A14 14 0 0 1 32 16 A15 15 0 0 1 52 28 A13 13 0 0 1 50 54 Z"/>',
  pebble: '<ellipse cx="32" cy="34" rx="28" ry="24"/>',
  egg: '<ellipse cx="32" cy="34" rx="23" ry="27"/>',
  bean: '<ellipse cx="32" cy="34" rx="27" ry="22"/>',
}
const BLOB = '<path d="M32 5 C48 5 60 16 59 32 C58 48 47 60 31 59 C15 58 5 47 5 31 C5 15 16 5 32 5 Z"/>'
const EYES =
  '<ellipse cx="24" cy="31" rx="5" ry="6.5" fill="#fff"/><ellipse cx="40" cy="31" rx="5" ry="6.5" fill="#fff"/>' +
  '<circle cx="25" cy="32" r="2.4" fill="#1d1d1f"/><circle cx="41" cy="32" r="2.4" fill="#1d1d1f"/>'

/** The character as SVG: its body in the colour, two eyes. */
export function characterSVG(shape, fill) {
  const colour = /^#[0-9a-fA-F]{6}$/.test(String(fill)) ? fill : '#777777'
  const body = Object.hasOwn(BODIES, shape) ? BODIES[shape] : BLOB
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><g fill="${colour}">${body}</g>${EYES}</svg>`
}

/** The avatar URL for a bot as the SDK lists it (bot.avatar from resolveAgentAvatar); '' when there is nothing to draw. */
export function avatarURL(bot) {
  const a = bot?.avatar
  const picture = a?.picture?.url
  if (typeof picture === 'string' && (/^https:\/\//.test(picture) || /^data:image\//.test(picture))) return picture
  const c = a?.character
  if (!c?.baseHex) return ''
  return 'data:image/svg+xml;base64,' + Buffer.from(characterSVG(c.shape, c.baseHex)).toString('base64')
}
