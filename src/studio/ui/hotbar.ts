/** 家具庫分類：點分類只顯示該組，3D 另有「房間」 */
export function mountHotbar(root: HTMLElement) {
  const lib = root.querySelector<HTMLElement>("#lib")
  const cats = root.querySelector<HTMLElement>("#libCats")
  const aside = root.querySelector<HTMLElement>("aside.hps-lib")
  if (!lib || !cats || !aside) return () => {}

  const sections = [...lib.querySelectorAll<HTMLElement>(":scope > h4")].map((title) => {
    const grid = title.nextElementSibling
    const section = document.createElement("div")
    section.className = "hps-catsec"
    title.before(section)
    section.append(title)
    if (grid) section.append(grid)
    return { name: title.textContent ?? "", section }
  })

  const pick = (index: number) => {
    const rooms = index < 0
    aside.classList.toggle("show-rooms", rooms)
    sections.forEach((item, i) => item.section.classList.toggle("on", !rooms && i === index))
    cats.querySelectorAll<HTMLButtonElement>(".hps-cat").forEach((button) => {
      button.classList.toggle("on", rooms ? button.dataset.cat === "rooms" : button.dataset.cat === String(index))
    })
  }

  const roomBtn = document.createElement("button")
  roomBtn.type = "button"
  roomBtn.className = "hps-cat hps-only3d"
  roomBtn.dataset.cat = "rooms"
  roomBtn.textContent = "房間"
  roomBtn.addEventListener("click", () => pick(-1))
  cats.append(roomBtn)

  sections.forEach((item, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "hps-cat"
    button.dataset.cat = String(index)
    button.textContent = item.name
    button.addEventListener("click", () => pick(index))
    cats.append(button)
  })
  pick(0)

  const onView = (event: Event) => {
    const button = event.currentTarget as HTMLElement
    if (button.dataset.view === "2d" && aside.classList.contains("show-rooms")) pick(0)
  }
  const viewButtons = [...root.querySelectorAll<HTMLElement>("#viewSeg .hps-btn")]
  viewButtons.forEach((button) => button.addEventListener("click", onView))

  return () => viewButtons.forEach((button) => button.removeEventListener("click", onView))
}
