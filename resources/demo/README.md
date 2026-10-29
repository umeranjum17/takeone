# Tidewater board fixture

`tidewater-board.png` is a 2560×1440 headless screenshot of
`scripts/e2e/scene.html`, captured before any interaction. The scene is a
fictional launch board with Umer as its demo person. No desktop, accounts,
network content or personal applications are involved.

The screenshot is frozen for the theme proof. See the [theme preview guidance](../../docs/look.md)
for the generator, committed preview status and framing settings.

## Tidewater brand fixture

`tidewater-brand.json` and `tidewater-mark.svg` are a fictional brand (colours, bundled display, body and mono
fonts, a drawn logo mark) for `takeone motion --recipe glow --brand resources/demo/tidewater-brand.json`.
# Welcome batch template

`batch/welcome.json` is a storyboard template whose `{{name}}`, `{{company}}`,
`{{plan}}` and `{{accent}}` fields are filled from each row of
`batch/customers.csv` by `takeone motion --storyboard batch/welcome.json --data
 batch/customers.csv`. The rows are fictional customers of the fictional Tidewater
 product, chosen as edge cases: a long name and company, a light accent and a dark one.
