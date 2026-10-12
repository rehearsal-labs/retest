// A page with each layout problem a layout matcher measures, at sizes set in CSS pixels so the measurement is the same
// on every machine. Below 500 pixels wide the Help button moves left onto Save, sharing 32 by 32 pixels with it, and
// the price, 300 pixels from the left and 104 wide, ends 14 pixels past a 390 pixel viewport, which makes the page 404
// pixels wide. At any width the title runs 14 pixels past the 200 pixel card that hides its overflow, the shortened
// note is cut short on purpose with an ellipsis, and the clear button sits inside the search field.

/** The page, served at `/`. */
export const layoutPage: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout</title>
<link rel="icon" href="data:,">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/20px sans-serif; }
  .toolbar { position: relative; height: 48px; }
  .toolbar button { position: absolute; top: 8px; width: 120px; height: 32px; margin: 0; padding: 0; }
  [data-testid="save"] { left: 8px; }
  [data-testid="help"] { right: 8px; }
  @media (max-width: 500px) { [data-testid="help"] { left: 96px; right: auto; } }
  .search { position: relative; height: 48px; }
  .search input { position: absolute; left: 8px; top: 4px; width: 300px; height: 40px; margin: 0; }
  .search button { position: absolute; left: 268px; top: 8px; width: 32px; height: 32px; margin: 0; padding: 0; }
  [data-testid="card"] { width: 200px; height: 20px; margin: 8px; overflow: hidden; white-space: nowrap; }
  [data-testid="clipped-title"] { display: inline-block; width: 214px; height: 20px; }
  [data-testid="shortened"] { width: 200px; height: 20px; margin: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-testid="price"] { position: absolute; left: 300px; top: 220px; width: 104px; height: 20px; margin: 0; }
</style>
</head>
<body>
<div class="toolbar"><button data-testid="save">Save</button><button data-testid="help">Help</button></div>
<div class="search"><input data-testid="search" aria-label="Search"><button data-testid="clear" aria-label="Clear">x</button></div>
<div data-testid="card"><span data-testid="clipped-title">Release checklist for the spring launch</span></div>
<div data-testid="shortened">A note that is far too long to fit, cut short with an ellipsis on purpose</div>
<p data-testid="price">12.00 EUR</p>
</body>
</html>
`
