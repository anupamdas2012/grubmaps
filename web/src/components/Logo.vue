<template>
  <a class="logo" href="/" aria-label="grubmaps">
    <svg class="logo-pin" viewBox="0 0 44 44" width="36" height="36" aria-hidden="true">
      <defs>
        <linearGradient id="grub-fork" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#4bd06d" />
          <stop offset="1" stop-color="#1f9e3d" />
        </linearGradient>
        <linearGradient id="grub-knife" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffc86b" />
          <stop offset="1" stop-color="#d97706" />
        </linearGradient>
      </defs>

      <!-- Knife (tilted up-right, behind) -->
      <g transform="rotate(22 22 22)">
        <path
          d="M20 4
             Q 20 3 22 3
             Q 24 3 24 4
             L 24 20
             L 20 20 Z"
          fill="url(#grub-knife)"
        />
        <rect x="20.5" y="19" width="3" height="22" rx="1.5" fill="url(#grub-knife)" />
      </g>

      <!-- Fork (tilted up-left, in front) -->
      <g transform="rotate(-22 22 22)">
        <rect x="17.7" y="3.5" width="1.5" height="9" rx="0.6" fill="url(#grub-fork)" />
        <rect x="20.3" y="3.5" width="1.5" height="9" rx="0.6" fill="url(#grub-fork)" />
        <rect x="22.9" y="3.5" width="1.5" height="9" rx="0.6" fill="url(#grub-fork)" />
        <rect x="17.5" y="11" width="7" height="2.6" rx="1.2" fill="url(#grub-fork)" />
        <rect x="20.5" y="13" width="3" height="27" rx="1.5" fill="url(#grub-fork)" />
      </g>

      <!-- A tiny sauce splat / bite spark for playful energy -->
      <circle cx="34" cy="10" r="2.2" fill="#ff5c8a" />
      <circle cx="36.5" cy="7" r="1" fill="#ff5c8a" />
    </svg>
    <span class="logo-word">
      <span class="grub">grub</span><span class="maps">maps</span>
    </span>
  </a>
</template>
