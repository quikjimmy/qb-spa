<script setup lang="ts">
// "Battery only" marker — placeholder system size (< 1 kW) plus a battery
// adder. Informational, not an alert, so it uses a calm teal tone (kept
// clear of the status palette and any warm/actionable colours).
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold bg-teal-50 text-teal-700"
    title="Battery only — no meaningful system size, has a battery adder"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="16" height="10" x="2" y="7" rx="2" ry="2" />
      <line x1="22" x2="22" y1="11" y2="13" />
    </svg>
    Battery
  </span>
</template>
