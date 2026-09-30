/** How many rows the list of identical rows has: more than an observation lists. */
export const ROW_COUNT = 120

const ROWS = Array.from({ length: ROW_COUNT }, () => '<li>Row</li>').join('')

/**
 * A page that proves how role, label and text locators find elements, one rule per element. Each element a rule
 * should find carries text of its own, which an observation reads back, so a test can tell which one it found.
 */
export const LOCATORS_PAGE: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Locators</title>
<link rel="icon" href="data:,">
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 40px; }
section { margin-bottom: 24px; }
</style>
</head>
<body>
<main>
<h1>Locators</h1>

<section aria-label="Names">
<button>Save</button>
<button>save</button>
<button>  Save
    draft  </button>
<button aria-label="Close dialog">×</button>
<span id="archive-name">Archive   task</span>
<button aria-labelledby="archive-name">archive</button>
<button title="Print page"><span aria-hidden="true">print</span></button>
<button aria-label='It&apos;s "quoted" \ text'>quoted</button>
<button aria-label="Start" data-testid="toggle">toggle</button>
</section>

<section aria-label="Hidden">
<button aria-label="Delete">shown</button>
<button aria-label="Delete" aria-hidden="true">aria-hidden</button>
<div aria-hidden="true"><button aria-label="Delete">inside aria-hidden</button></div>
<button aria-label="Delete" style="display: none">display none</button>
<div style="display: none"><button aria-label="Delete">inside display none</button></div>
<button aria-label="Delete" hidden>hidden attribute</button>
<button aria-label="Delete" style="visibility: hidden">visibility hidden</button>
<div inert><button aria-label="Delete">inert</button></div>
</section>

<section aria-label="Fields">
<label for="email">Email</label><input id="email" value="email by label for">
<label for="email-copy">email</label><input id="email-copy" value="email in lower case">
<label>Full   name <input value="name by wrapping label"></label>
<input type="search" title="Search tasks" value="search by title">
<input placeholder="City" value="city by placeholder">
<input aria-label="Phone" value="phone by aria-label">
<span id="notes-name">Notes</span><textarea aria-labelledby="notes-name">notes by aria-labelledby</textarea>
<label for="agree">I agree</label><input id="agree" type="checkbox">
<label for="size">Size</label><select id="size"><option>Small</option><option selected>Large</option></select>
<label for="hidden-field">Hidden field</label><input id="hidden-field" style="display: none">
<button aria-label="Email">email button</button>
</section>

<section aria-label="Text">
<p>Welcome back</p>
<div><span>Plan</span> <strong>pro</strong></div>
<p>  Ship
    it  </p>
<p>Release <b>notes</b></p>
<script>/* Welcome back */</script>
<style>/* Welcome back */</style>
<template><p>Welcome back</p></template>
<noscript>Welcome back</noscript>
<p style="display: none">Hidden note</p>
<p>It's "quoted" \ text</p>
</section>

<section aria-label="Trees">
<button aria-label="Tree one">one</button>
<div id="host"></div>
<button aria-label="Tree three">three</button>
<iframe title="Framed" srcdoc="<button aria-label='Tree framed'>framed</button><p>Framed text</p>"></iframe>
</section>

<section aria-label="Pictures">
<img alt="Logo" src="data:,">
<svg role="img" aria-label="Badge" width="16" height="16"></svg>
<math aria-label="Formula"><mi>x</mi></math>
</section>

<ul aria-label="Rows">${ROWS}</ul>
</main>
<script>
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button aria-label="Tree two">two</button>'
const toggle = document.querySelector('[data-testid="toggle"]')
toggle.addEventListener('click', () => {
  toggle.setAttribute('aria-label', toggle.getAttribute('aria-label') === 'Start' ? 'Stop' : 'Start')
})
</script>
</body>
</html>
`
