const monarchWing = `
    <path d="M140 93C108 51 70 23 41 28c-7 29 6 70 50 78-26 3-37 20-24 35 18 21 57 11 73-25Z" fill="#3a202c" stroke="#ffce8b" stroke-width="3"/>
    <path d="M131 94C103 64 69 37 47 36c-2 23 9 52 40 61 15 4 31 2 44-3Z" fill="#f8a146"/>
    <path d="M132 105c-19 6-36 4-48 10-17 8-13 22 0 27 18 7 39-11 48-37Z" fill="#ffcb66"/>
    <path d="M55 43c15 29 37 44 76 51M65 77l22 2 9-9m13 38-14 16-19 5m32 8 1-16" fill="none" stroke="#92493c" stroke-width="3" stroke-linecap="round"/>
    <path d="M51 66l4 8m10 13 6 4m10 56 6 1" fill="none" stroke="#fff2ce" stroke-width="4" stroke-linecap="round"/>`;

export const themeArtwork = {
  minecraft: `
      <ellipse cx="152" cy="154" rx="106" ry="15" fill="#0e190e" opacity=".6"/>
      <path d="M39 104l48-27 50 27v43l-50 27-48-27z" fill="#754832"/>
      <path d="M87 130l50-26v43l-50 27z" fill="#4c3225"/>
      <path d="M39 104l48-27 50 27-50 27z" fill="#77ad4b"/>
      <path d="M39 104l48 27v13l-12-7v-5l-13-7v5l-12-7v-5l-11-6z" fill="#527f34"/>
      <path d="M87 131l50-27v11l-14 8v-5l-12 7v5l-12 6v-5l-12 7z" fill="#375c2b"/>
      <path d="M114 58l58-33 59 33v59l-59 33-58-33z" fill="#8b5839"/>
      <path d="M172 91l59-33v59l-59 33z" fill="#513624"/>
      <path d="M114 58l58-33 59 33-59 34z" fill="#91cd5f"/>
      <path d="M114 58l58 34v17l-13-8v-6l-15-8v5l-13-7v-6l-17-10z" fill="#60953d"/>
      <path d="M172 92l59-34v14l-13 8v-5l-15 9v6l-14 8v-5l-17 10z" fill="#3e7232"/>
      <path d="M138 58l13-8 13 7-13 8zM173 45l13 8-13 7-13-7zM183 68l12-7 12 7-12 7z" fill="#a9db79"/>
      <path d="M126 99l10 6v8l-10-6zM150 112l10 6v8l-10-6zM191 111l10-6v8l-10 6zM211 96l10-6v8l-10 6z" fill="#b17b4c" opacity=".56"/>
      <path d="M71 55h8v-8h7v8h8v7h-8v8h-7v-8h-8zM235 29h6v-6h6v6h6v6h-6v6h-6v-6h-6z" fill="#c2e99d" opacity=".75"/>`,
  amethyst: `
      <ellipse cx="153" cy="151" rx="102" ry="15" fill="#160d26" opacity=".72"/>
      <g stroke="#e9cfff" stroke-width="1.4" stroke-linejoin="round">
        <path d="M105 148 68 95 67 67 96 76 133 132Z" fill="#8649ba"/>
        <path d="m67 67 17 24 21 57-37-53z" fill="#c992f4"/>
        <path d="m105 148 5-67 36-62 35 43-8 72-29 24z" fill="#ac68dc"/>
        <path d="m146 19 2 60-4 79-39-10 5-67z" fill="#d3a1f5"/>
        <path d="m146 19 35 43-33 17-38 2z" fill="#e9c8ff"/>
        <path d="m148 79 33-17-8 72-29 24z" fill="#8d49c4"/>
        <path d="m165 150 22-60 36-34 9 35-29 50-26 16z" fill="#985bc9"/>
        <path d="m187 90 36-34-11 39-35 62-12-7z" fill="#c492ed"/>
        <path d="m223 56 9 35-20 4-25-5z" fill="#e8cbff"/>
      </g>
      <path d="M53 47h18m-9-9v18m147-29h16m-8-8v16m29 77h14m-7-7v14" fill="none" stroke="#f1dbff" stroke-width="2" stroke-linecap="round"/>
      <circle cx="94" cy="38" r="3" fill="#b789df"/><circle cx="240" cy="65" r="2.5" fill="#b789df"/>`,
  monarch: `
    ${monarchWing}
    <g transform="translate(280 0) scale(-1 1)">${monarchWing}</g>
    <path d="M140 90q-4-17-17-25m17 25q4-17 17-25" fill="none" stroke="#ffe4b1" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M140 91c-11 0-9 20 0 39 9-19 11-39 0-39Z" fill="#563141" stroke="#ffc77d" stroke-width="3"/>
    <circle cx="140" cy="89" r="6" fill="#ffe3ad"/>`,
  ocean: `
    <path d="M39 139c32 0 43-17 61-52 20-39 51-60 90-56-23 6-34 19-34 35 0 25 43 40 80 27-18 32-45 51-77 53-32 2-49-12-75-4-16 5-30 7-45-3Z" fill="#227d87"/>
    <path d="M42 137c35-9 41-27 59-54 24-36 48-52 89-52-24 10-36 22-36 38 0 24 39 36 81 24-20 21-49 26-74 21-29-6-47-4-75 15-17 11-30 12-44 8Z" fill="#72e4d3"/>
    <path d="M87 118c38-44 48-69 96-84-28 4-56 29-70 49-10 15-19 28-26 35Z" fill="#d2fff7"/>
    <path d="M53 153q20 9 43 0t43 0 43 0 44 0" fill="none" stroke="#91e1da" stroke-width="4" stroke-linecap="round"/>
    <circle cx="209" cy="54" r="5" fill="#9ef2e6"/><circle cx="229" cy="69" r="3" fill="#9ef2e6"/>`,
  sakura: `
    <path d="M47 150q66-9 104-54 27-31 73-46m-84 61q-25-30-54-43m87 11q25 5 48 18" fill="none" stroke="#b9868e" stroke-width="5" stroke-linecap="round"/>
    <g fill="#f6a9c4" stroke="#ffcfde" stroke-width="1.6">
      <path d="M144 88c-27-19-42-7-36 10-20 12-14 31 7 30 8 22 28 20 35-1 20 2 30-16 12-28 7-18-10-29-18-11Z"/>
      <path d="M206 39c-19-13-32-3-26 10-17 8-11 23 4 23 6 16 21 16 27 0 16 1 22-12 8-22 6-12-6-20-13-11Z"/>
      <path d="M82 51c-15-12-26-4-23 7-12 8-7 19 5 18 4 12 17 12 21 0 13 0 18-10 7-18 3-11-5-15-10-7Z"/>
    </g>
    <g fill="#ffd68d"><circle cx="136" cy="108" r="5"/><circle cx="201" cy="56" r="4"/><circle cx="77" cy="65" r="3"/></g>
    <path d="M193 128q14-10 24 0-10 12-24 0M51 100q-13-6-17 2 10 10 17-2" fill="#f7b7cb"/>`,
  ember: `
    <ellipse cx="140" cy="155" rx="75" ry="12" fill="#1a0d0e" opacity=".68"/>
    <path d="M139 153c-37 0-59-22-59-47 0-19 8-33 21-45-2 18 4 24 12 30 7-17 28-30 26-65 27 15 47 44 42 67 8-6 13-13 15-22 14 21 19 39 10 56-9 17-32 26-67 26Z" fill="#f16149"/>
    <path d="M144 153c-26 0-43-13-43-32 0-11 7-19 13-25-1 10 4 14 10 18 1-18 16-29 23-50 17 16 22 34 20 49 6-4 11-9 13-16 11 21 0 56-36 56Z" fill="#ffad66"/>
    <path d="M142 153c-14 0-23-10-21-20 1-5 4-9 8-13 3 6 7 8 10 8 6-7 8-14 8-21 12 8 20 22 14 34-3 7-10 12-19 12Z" fill="#fff0a7"/>
    <path d="m89 43 7-12m103 17 8-12m13 56 10-5" stroke="#ffa36d" stroke-width="4" stroke-linecap="round"/>`,
  frost: `
    <circle cx="141" cy="89" r="67" fill="#204a61" opacity=".72"/>
    <g fill="none" stroke="#bcefff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M141 22v134m-58-100 116 67m0-67L83 123"/>
      <path d="m126 33 15 17 15-17m-30 113 15-17 15 17m-82-71 24-3-6-22m98 78-7-22 24-3M91 129l7-22-24-3m133-29-24-3 7-22"/>
    </g>
    <path d="m141 69 17 10v20l-17 10-17-10V79Z" fill="#7fc5e7" stroke="#effcff" stroke-width="2"/>
    <g fill="#a7e7ff"><circle cx="63" cy="43" r="4"/><circle cx="220" cy="124" r="4"/><circle cx="216" cy="37" r="3"/></g>`,
  desert: `
    <circle cx="184" cy="61" r="31" fill="#ffd685"/>
    <path d="M50 130q40-25 76-22t70-16q19-11 44-3v50H50Z" fill="#b77d53"/>
    <path d="M43 133q42-6 75-33t61 2q21 18 60 18v23H43Z" fill="#dfa469"/>
    <path d="M43 138q42 6 92-15t105-5v32H43Z" fill="#f3c98b"/>
    <path d="M44 146q46 6 91-8t105-9" fill="none" stroke="#f9ddb0" stroke-width="3" stroke-linecap="round"/>
    <path d="M88 117v-31m0 21h-8q-4 0-4-5v-8m12 7h7q4 0 4-5v-6" fill="none" stroke="#6f7760" stroke-width="5" stroke-linecap="round"/>`,
  midnight: `
    <circle cx="149" cy="89" r="66" fill="#303967" opacity=".72"/>
    <path d="M171 30a61 61 0 1 0 54 87 56 56 0 0 1-54-87Z" fill="#ccd5ff"/>
    <path d="M89 72a58 58 0 0 0 105 66 60 60 0 0 1-105-66Z" fill="#9daff8"/>
    <path d="M199 35v20m-10-10h20m-4 36v14m-7-7h14M69 57v12m-6-6h12m148 45v12m-6-6h12" stroke="#e3e9ff" stroke-width="2.5" stroke-linecap="round"/>
    <g fill="#adbfff"><circle cx="222" cy="66" r="3"/><circle cx="77" cy="101" r="3"/><circle cx="179" cy="66" r="2"/></g>`,
};
