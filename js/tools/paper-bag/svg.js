// js/tools/paper-bag/svg.js — 建 SVG 節點。展開圖與組裝動畫共用。

export const SVG_NS = "http://www.w3.org/2000/svg";

/** 建 SVG 節點。utils 的 el() 走 createElement，對 SVG 不管用。 */
export function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}
