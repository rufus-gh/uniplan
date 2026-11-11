import type { SVGProps } from 'react'
import type { Provider } from '../../../shared/types'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  )
}

export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)
export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3 3" />
  </Svg>
)
export const Trash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Svg>
)
export const ArrowUp = (p: P) => (
  <Svg {...p} strokeWidth={1.8}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Svg>
)
export const Square = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
)
export const ImageIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="2" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="m2.75 11.5 3.25-3 2.5 2.25L10.5 9l2.75 2.5" />
  </Svg>
)
export const Sidebar = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="2" />
    <path d="M6.5 3v10" />
  </Svg>
)
export const Copy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </Svg>
)
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
)
export const Chevron = (p: P) => (
  <Svg {...p}>
    <path d="m5 6.5 3 3 3-3" />
  </Svg>
)
export const X = (p: P) => (
  <Svg {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Svg>
)
export const Retry = (p: P) => (
  <Svg {...p}>
    <path d="M3 8a5 5 0 1 0 1.5-3.55M3 3v2.5h2.5" />
  </Svg>
)
export const Alert = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5.25v3.25M8 10.75v.01" />
  </Svg>
)
export const Chat = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 2.75h7A1.75 1.75 0 0 1 13.25 4.5v5a1.75 1.75 0 0 1-1.75 1.75H7.6L4.75 13.5v-2.25H4.5A1.75 1.75 0 0 1 2.75 9.5v-5A1.75 1.75 0 0 1 4.5 2.75Z" />
  </Svg>
)
export const Sun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
  </Svg>
)
export const Bolt = (p: P) => (
  <Svg {...p}>
    <path d="M8.75 2 4 9h3.5l-.75 5L11.5 7H8z" />
  </Svg>
)
export const Pencil = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 3.5 12.5 5.5 6 12H4v-2z" />
  </Svg>
)
export const Terminal = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="m5 6.5 2 1.5-2 1.5M8.5 10H11" />
  </Svg>
)

// Brand marks, shown next to each provider's models.

export const ClaudeLogo = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Claude" role="img" style={{ flex: 'none' }}>
    <path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
)

export const OpenAILogo = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-label="OpenAI" role="img" style={{ flex: 'none' }}>
    <path fill="currentColor" fillRule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </svg>
)

export const Gear = (p: P) => (
  <Svg {...p}>
    <path d="M6.9 2.5a1.2 1.2 0 0 1 2.2 0l.3.8a1.2 1.2 0 0 0 1.4.8l.8-.3a1.2 1.2 0 0 1 1.6 1.6l-.3.8a1.2 1.2 0 0 0 .8 1.4l.8.3a1.2 1.2 0 0 1 0 2.2l-.8.3a1.2 1.2 0 0 0-.8 1.4l.3.8a1.2 1.2 0 0 1-1.6 1.6l-.8-.3a1.2 1.2 0 0 0-1.4.8l-.3.8a1.2 1.2 0 0 1-2.2 0l-.3-.8a1.2 1.2 0 0 0-1.4-.8l-.8.3a1.2 1.2 0 0 1-1.6-1.6l.3-.8a1.2 1.2 0 0 0-.8-1.4l-.8-.3a1.2 1.2 0 0 1 0-2.2l.8-.3a1.2 1.2 0 0 0 .8-1.4l-.3-.8a1.2 1.2 0 0 1 1.6-1.6l.8.3a1.2 1.2 0 0 0 1.4-.8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
)

export const ProviderLogo = ({ provider, size = 14 }: { provider: Provider; size?: number }) => {
  switch (provider) {
    case 'claude':
      return <ClaudeLogo size={size} />
    case 'openai':
      return <OpenAILogo size={size} />
  }
}

export const Book = (p: P) => (
  <Svg {...p}>
    <path d="M3 3.5h3.5A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z" />
  </Svg>
)
export const FileIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3" />
  </Svg>
)
export const Upload = (p: P) => (
  <Svg {...p}>
    <path d="M8 10.5V3M5 5.5 8 2.5l3 3M3 10v2.5h10V10" />
  </Svg>
)
export const Dots = (p: P) => (
  <Svg {...p}>
    <circle cx="4" cy="8" r=".9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

/** Lemma's mark: nested hexagons, pure black and white. Matches resources/icon.svg. */
// In-app colours follow the theme: tile = sidebar background, mark = the "Lemma" text colour.
const INK = 'var(--text)'
const BG = { fill: 'var(--bg-sidebar)' }
const INKFILL = { fill: INK, stroke: INK }
const BGFILL = { fill: 'var(--bg-sidebar)', stroke: 'var(--bg-sidebar)' }

export const LemmaMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="100 100 824 824" aria-label="Lemma" role="img" style={{ flex: 'none' }}>
    <rect x="100" y="100" width="824" height="824" rx="186" style={BG} />
    <polygon points="512.0,227.0 758.8,369.5 758.8,654.5 512.0,797.0 265.2,654.5 265.2,369.5" style={INKFILL} strokeWidth="40" strokeLinejoin="round" />
    <polygon points="512.0,332.0 667.9,422.0 667.9,602.0 512.0,692.0 356.1,602.0 356.1,422.0" style={BGFILL} strokeWidth="30" strokeLinejoin="round" />
    <polygon points="512.0,424.0 588.2,468.0 588.2,556.0 512.0,600.0 435.8,556.0 435.8,468.0" style={INKFILL} strokeWidth="24" strokeLinejoin="round" />
  </svg>
)

/** Five rising bars, `level` (1–5) of them filled: the effort indicator. */
export const EffortBars = ({ level, size = 14 }: { level: number; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ flex: 'none' }}>
    {[0, 1, 2, 3, 4].map((i) => (
      <rect
        key={i}
        x={1 + i * 3}
        y={12 - (i + 1) * 2.2}
        width="2"
        height={(i + 1) * 2.2 + 1.5}
        rx="0.8"
        fill="currentColor"
        opacity={i < level ? 1 : 0.25}
      />
    ))}
  </svg>
)
export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.55M13 3v2.5h-2.5" />
  </Svg>
)

export const Target = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 2.5V1M8 15v-1.5M2.5 8H1M15 8h-1.5" />
  </Svg>
)

export const ArrowDown = (p: P) => (
  <Svg {...p} strokeWidth={1.8}>
    <path d="M8 3v9.5M4 8.5l4 4 4-4" />
  </Svg>
)
