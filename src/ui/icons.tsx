// SPDX-License-Identifier: AGPL-3.0-only
// The pictures on the tool's keys: the modelling features, the sketch tools,
// relations and dimensions, the element types of both Measure workspaces,
// the marking tools, the ends of the list rows, the view bar and the top
// bar. Drawn for this tool on a 24-unit grid with a 1.5-unit stroke, to four
// rules the whole set keeps:
//
//   ink (currentColor)  what is there — the body, the sketch, the first piece
//                       picked; it follows the key's text colour, so hover,
//                       pressed and disabled need nothing of their own
//   blue (--accent)     what the key does — the body a feature makes, the edge
//                       it changes, the clicks a tool asks for, in order
//   dashed              what goes or is only referred to — the half cut away,
//                       the corner before the round, an axis
//   dots                the scan, wherever a feature reads the mesh
//
// The classes (i-a accent stroke, i-f accent stroke on a soft fill, i-g ink
// with a faint fill, i-gf the faint fill alone, i-dt / i-adt dots, i-th thin,
// i-ft faint, i-ds dashed, i-ax a centre line, i-as a faint accent stroke)
// live in styles.css under svg.icon.

import type { ReactNode } from 'react'

const ICONS = {
  // features
  sketch: (
    <>
      <path className="i-g" d="M2.5 18 8.5 7h13l-6 11Z" />
      <path className="i-a" d="M8 15.5 11 10h6l-3 5.5Z" />
      <circle className="i-adt" cx="8" cy="15.5" r="1.3" />
      <circle className="i-adt" cx="11" cy="10" r="1.3" />
      <circle className="i-adt" cx="17" cy="10" r="1.3" />
      <circle className="i-adt" cx="14" cy="15.5" r="1.3" />
    </>
  ),
  extrude: (
    <>
      <path className="i-f" d="M4 12h11v8H4Z" />
      <path className="i-f" d="m15 12 4-4v8l-4 4Z" />
      <path className="i-f" d="m4 12 4-4h11l-4 4Z" />
      <path d="M4 20h11l4-4" />
      <path className="i-a" d="M11.5 10V1.5M9.3 3.7l2.2-2.2 2.2 2.2" />
    </>
  ),
  revolve: (
    <>
      <path className="i-f" d="M12 8.5H6.5v4H9v9h3Z" />
      <path className="i-g" d="M12 8.5h5.5v4H15v9h-3Z" />
      <path className="i-ax i-ft" d="M12 1v22" />
      <path className="i-a" d="M17 3.6A5 1.8 0 0 1 7.59 4.45M8.41 6.6l-.82-2.15 2.3-.03" />
    </>
  ),
  extract: (
    <>
      <path className="i-f" d="M6 7v10a6 2.5 0 0 0 12 0V7Z" />
      <ellipse className="i-f" cx="12" cy="7" rx="6" ry="2.5" />
      <circle className="i-dt" cx="12" cy="2.2" r=".95" />
      <circle className="i-dt" cx="3.4" cy="6" r=".95" />
      <circle className="i-dt" cx="20.8" cy="9" r=".95" />
      <circle className="i-dt" cx="3" cy="13" r=".95" />
      <circle className="i-dt" cx="21" cy="15.5" r=".95" />
      <circle className="i-dt" cx="7" cy="21.6" r=".95" />
      <circle className="i-dt" cx="16.5" cy="22" r=".95" />
    </>
  ),
  shell: (
    <>
      <path className="i-g" d="M4 6h3v11h10V6h3v14H4Z" />
      <path className="i-a" d="M7 6v11h10V6" />
    </>
  ),
  fillet: (
    <>
      <path className="i-gf" d="M4 12a8 8 0 0 1 8-8h8v16H4Z" />
      <path d="M12 4h8v16H4v-8" />
      <path className="i-th i-ft i-ds" d="M4 12V4h8" />
      <path className="i-a" d="M4 12a8 8 0 0 1 8-8" />
    </>
  ),
  chamfer: (
    <>
      <path className="i-gf" d="m4 12 8-8h8v16H4Z" />
      <path d="M12 4h8v16H4v-8" />
      <path className="i-th i-ft i-ds" d="M4 12V4h8" />
      <path className="i-a" d="m4 12 8-8" />
    </>
  ),
  draft: (
    <>
      <path className="i-gf" d="M4 20h16L17 4H4Z" />
      <path d="M17 4H4v16h16" />
      <path className="i-th i-ft i-ds" d="M20 20V4h-3" />
      <path className="i-a" d="M20 20 17 4" />
    </>
  ),
  moveFace: (
    <>
      <path className="i-gf" d="M4 11h16v9H4Z" />
      <path d="M4 11v9h16v-9" />
      <path className="i-th i-ft i-ds" d="M4 11h16" />
      <path className="i-a" d="M4 4.5h16M12 10V6.5m-2 1.8 2-2 2 2" />
    </>
  ),
  project: (
    <>
      <path className="i-g" d="M3 20h18" />
      <path className="i-th i-ft i-ds" d="M6 5v15M18 8.5V20" />
      <path d="m6 5 12 3.5" />
      <path className="i-a" d="M6 20h12" />
    </>
  ),
  hole: (
    <>
      <path className="i-g" d="M2.5 12h14v7h-14Z" />
      <path className="i-g" d="m16.5 12 5-6v7l-5 6Z" />
      <path className="i-g" d="m2.5 12 5-6h14l-5 6Z" />
      <ellipse className="i-f" cx="12" cy="9" rx="3.5" ry="1.6" />
      <path className="i-a i-ax" d="M12 1.5V9" />
    </>
  ),
  cutPlane: (
    <>
      <path className="i-g" d="M4 9h9v10H4Z" />
      <path className="i-th i-ft i-ds" d="M13 9h7v10h-7" />
      <path className="i-f" fillOpacity=".8" d="m11 7 4-3.5v15L11 22Z" />
    </>
  ),
  mirror: (
    <>
      <path className="i-g" d="M9 5v14H3Z" />
      <path className="i-f" d="M15 5v14h6Z" />
      <path className="i-a i-ax" d="M12 1.5v21" />
    </>
  ),
  combine: (
    <>
      <rect className="i-g" x="3" y="3" width="11" height="11" />
      <circle className="i-g" cx="15" cy="15" r="6" />
      <path className="i-f" d="M14 9.08V14H9.08A6 6 0 0 1 14 9.08Z" />
    </>
  ),
  sheet: (
    <>
      <path className="i-f" d="M3 18c5-6 9 4 16-3l2-9c-7 7-11-3-16 3Z" />
      <path d="M3 18c5-6 9 4 16-3" />
    </>
  ),
  split: (
    <>
      <path className="i-g" d="M3 7h7c-1.5 4 1.5 7 0 11H3Z" />
      <path className="i-g" d="M14 7h7v11h-7c1.5-4-1.5-7 0-11Z" />
      <path className="i-a" d="M12 3c-1.5 5.5 1.5 12.5 0 18" />
    </>
  ),
  loft: (
    <>
      <path className="i-f" d="M4 18C4 12 8 10 8 5a4 1.8 0 0 0 8 0c0 5 4 7 4 13a8 3 0 0 1-16 0Z" />
      <ellipse className="i-g" cx="12" cy="5" rx="4" ry="1.8" />
      <path d="M4 18a8 3 0 0 0 16 0" />
    </>
  ),
  pattern: (
    <>
      <circle className="i-f" cx="18.06" cy="8.5" r="2.4" />
      <circle className="i-f" cx="18.06" cy="15.5" r="2.4" />
      <circle className="i-f" cx="12" cy="19" r="2.4" />
      <circle className="i-f" cx="5.94" cy="15.5" r="2.4" />
      <circle className="i-f" cx="5.94" cy="8.5" r="2.4" />
      <circle className="i-g" cx="12" cy="5" r="2.4" />
      <path className="i-th i-ft" d="M10.6 12h2.8M12 10.6v2.8" />
    </>
  ),
  surface: (
    <>
      <path className="i-f" d="M3 13q5-8 11-8 5 3 7 8-6 1-11 7-5-2-7-7Z" />
      <path className="i-a i-th" d="M8.25 7q4.75 3 7 8.25M5.75 17.25Q10 11 18.25 8.5" />
      <circle className="i-dt" cx="6.3" cy="11" r=".95" />
      <circle className="i-dt" cx="11" cy="7.6" r=".95" />
      <circle className="i-dt" cx="15.6" cy="9.4" r=".95" />
      <circle className="i-dt" cx="9.2" cy="14.6" r=".95" />
      <circle className="i-dt" cx="13.4" cy="12.6" r=".95" />
      <circle className="i-dt" cx="12" cy="17" r=".95" />
      <circle className="i-dt" cx="18.2" cy="12.4" r=".95" />
    </>
  ),
  trim: (
    <>
      <path className="i-th i-ft i-ds" d="M2 17h4.9M17.1 17H22M5 21l1.9-4M12 6.22 14 2M19 21l-1.9-4M12 6.22 10 2" />
      <path className="i-f" d="M6.9 17h10.2L12 6.22Z" />
    </>
  ),

  // body operations
  opNew: (
    <>
      <rect className="i-g" x="3" y="3" width="9.5" height="9.5" />
      <circle className="i-f" cx="16" cy="16" r="5" />
    </>
  ),
  opJoin: (
    <>
      <path className="i-f" d="M3 3h11v6.08A6 6 0 1 1 9.08 14H3Z" />
    </>
  ),
  opCut: (
    <>
      <path className="i-g" d="M3 3h11v6.08A6 6 0 0 0 9.08 14H3Z" />
      <path className="i-a i-ds" d="M14 9.08A6 6 0 1 1 9.08 14" />
    </>
  ),
  opIntersect: (
    <>
      <path className="i-th i-ft i-ds" d="M14 9.08V3H3v11h6.08" />
      <path className="i-th i-ft i-ds" d="M14 9.08A6 6 0 1 1 9.08 14" />
      <path className="i-f" d="M14 9.08V14H9.08A6 6 0 0 1 14 9.08Z" />
    </>
  ),

  // sketch tools
  select: (
    <>
      <path className="i-g" d="M6 3v15l4-3.5 2.8 6 2.2-1-2.7-5.9 5.2-.4Z" />
    </>
  ),
  line: (
    <>
      <path d="M5 18.5 19 5.5" />
      <circle className="i-adt" cx="5" cy="18.5" r="1.8" />
      <circle className="i-adt" cx="19" cy="5.5" r="1.8" />
    </>
  ),
  rectangle: (
    <>
      <rect x="4" y="6" width="16" height="12" />
      <circle className="i-adt" cx="4" cy="6" r="1.8" />
      <circle className="i-adt" cx="20" cy="18" r="1.8" />
    </>
  ),
  circle: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path className="i-a i-th i-ds" d="M12 12 17.66 6.34" />
      <circle className="i-adt" cx="12" cy="12" r="1.6" />
      <circle className="i-adt" cx="17.66" cy="6.34" r="1.8" />
    </>
  ),
  arc: (
    <>
      <path d="M4 17a8 8 0 0 1 16 0" />
      <circle className="i-adt" cx="4" cy="17" r="1.8" />
      <circle className="i-adt" cx="20" cy="17" r="1.8" />
      <circle className="i-adt" cx="12" cy="9" r="1.8" />
    </>
  ),
  gridSnap: (
    <>
      <path className="i-th i-ft" d="M3 8h18M3 16h18M8 3v18M16 3v18" />
      <circle className="i-a" cx="16" cy="8" r="3.4" />
      <circle className="i-adt" cx="16" cy="8" r="1.5" />
    </>
  ),
  fitAll: (
    <>
      <path className="i-a" d="M3 8h9a7 7 0 0 1 7 7v6" />
      <circle className="i-dt" cx="4" cy="7.2" r=".95" />
      <circle className="i-dt" cx="7" cy="8.8" r=".95" />
      <circle className="i-dt" cx="10" cy="7.3" r=".95" />
      <circle className="i-dt" cx="13.2" cy="8.9" r=".95" />
      <circle className="i-dt" cx="16" cy="8.6" r=".95" />
      <circle className="i-dt" cx="17.5" cy="12" r=".95" />
      <circle className="i-dt" cx="19.7" cy="14.6" r=".95" />
      <circle className="i-dt" cx="18.3" cy="17.8" r=".95" />
      <circle className="i-dt" cx="19.6" cy="20.6" r=".95" />
    </>
  ),
  inferCorners: (
    <>
      <path d="M4 19.5 10.07 8.5M20 19.5 13.93 8.5" />
      <path className="i-a i-ds" d="M10.07 8.5 12 5l1.93 3.5" />
      <circle className="i-adt" cx="12" cy="5" r="1.8" />
    </>
  ),
  closeChain: (
    <>
      <path d="M9 5H5v14h14V5h-4" />
      <path className="i-a" d="M9 5h6" />
      <circle className="i-adt" cx="9" cy="5" r="1.7" />
      <circle className="i-adt" cx="15" cy="5" r="1.7" />
    </>
  ),

  // relations
  coincident: (
    <>
      <path d="M4 5l8 7.5M12 12.5l8-4" />
      <circle className="i-a" cx="12" cy="12.5" r="3.6" />
      <circle className="i-adt" cx="12" cy="12.5" r="1.6" />
    </>
  ),
  horizontal: (
    <>
      <path d="M6 8h15" />
      <circle className="i-dt" cx="6" cy="8" r="1.5" />
      <circle className="i-dt" cx="21" cy="8" r="1.5" />
      <path className="i-th i-ft" d="M4 20.5v-7" />
      <path className="i-a" d="M4 20.5h9M10.8 18.3l2.2 2.2-2.2 2.2" />
    </>
  ),
  vertical: (
    <>
      <path d="M16 3v15" />
      <circle className="i-dt" cx="16" cy="3" r="1.5" />
      <circle className="i-dt" cx="16" cy="18" r="1.5" />
      <path className="i-th i-ft" d="M4 20.5h7" />
      <path className="i-a" d="M4 20.5v-9M1.8 13.7 4 11.5l2.2 2.2" />
    </>
  ),
  parallel: (
    <>
      <path d="M4 17 13 4" />
      <path className="i-a" d="M11 20l9-13" />
    </>
  ),
  perpendicular: (
    <>
      <path d="M3 19h18" />
      <path className="i-a" d="M12 19V4" />
      <path className="i-a i-th" d="M12 15.5h3.5V19" />
    </>
  ),
  tangent: (
    <>
      <circle cx="11" cy="15" r="6.5" />
      <path className="i-a" d="M7.32 5.37 21.18 13.37" />
      <circle className="i-adt" cx="14.25" cy="9.37" r="1.6" />
    </>
  ),
  concentric: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle className="i-a" cx="12" cy="12" r="4.5" />
      <circle className="i-adt" cx="12" cy="12" r="1.4" />
    </>
  ),
  symmetric: (
    <>
      <path className="i-ax i-ft" d="M12 2v20" />
      <circle className="i-g" cx="5.5" cy="12" r="3" />
      <circle className="i-f" cx="18.5" cy="12" r="3" />
      <path className="i-a i-th" d="M9.5 12h5M10.9 10.6 9.5 12l1.4 1.4M13.1 10.6l1.4 1.4-1.4 1.4" />
    </>
  ),

  // dimensions
  dimLength: (
    <>
      <path d="M5 18.5h14" />
      <path className="i-a i-th" d="M5 15V6M19 15V6" />
      <path className="i-a" d="M5 8.5h14M7.2 6.3 5 8.5l2.2 2.2M16.8 6.3 19 8.5l-2.2 2.2" />
    </>
  ),
  dimRadius: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path className="i-a" d="M12 12l6.01-6.01M14.9 6l3.11-.01-.01 3.11" />
      <circle className="i-adt" cx="12" cy="12" r="1.5" />
    </>
  ),
  dimDistance: (
    <>
      <path d="M4 4.5v15M20 4.5v15" />
      <path className="i-a" d="M4.8 12h14.4M7.6 9.2 4.8 12l2.8 2.8M16.4 9.2l2.8 2.8-2.8 2.8" />
    </>
  ),
  dimAngle: (
    <>
      <path d="M4 19h16.5M4 19 16.5 5.5" />
      <path className="i-a" d="M15 19a11 11 0 0 0-3.53-8.07" />
    </>
  ),

  // sketch edit
  del: (
    <>
      <path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13.5h9L17.5 7M10.3 10.5v6.5M13.7 10.5v6.5" />
    </>
  ),
  sharpCorner: (
    <>
      <path d="M4 20v-8M12 4h8" />
      <path className="i-th i-ft i-ds" d="M4 12a8 8 0 0 1 8-8" />
      <path className="i-a" d="M4 12V4h8" />
    </>
  ),
  filletCorner: (
    <>
      <path d="M4 20v-8M12 4h8" />
      <path className="i-th i-ft i-ds" d="M4 12V4h8" />
      <path className="i-a" d="M4 12a8 8 0 0 1 8-8" />
    </>
  ),
  chamferCorner: (
    <>
      <path d="M4 20v-8M12 4h8" />
      <path className="i-th i-ft i-ds" d="M4 12V4h8" />
      <path className="i-a" d="M4 12l8-8" />
    </>
  ),
  fix: (
    <>
      <rect className="i-g" x="5.5" y="11" width="13" height="9.500" rx="1.5" />
      <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
      <circle className="i-adt" cx="12" cy="15.7" r="1.6" />
    </>
  ),
  construction: (
    <>
      <path className="i-a i-ax" strokeWidth="1.5" d="M5 18.5 19 5.5" />
      <circle className="i-dt" cx="5" cy="18.5" r="1.6" />
      <circle className="i-dt" cx="19" cy="5.5" r="1.6" />
    </>
  ),
  alignSheet: (
    <>
      <path className="i-th i-ft i-ds" d="M3 19 19 7" />
      <path d="M3 19h18" />
      <path className="i-a" d="M14.2 10.6A14 14 0 0 1 16.86 17.05M15.22 15.29l1.64 1.76 1.1-2.14" />
      <circle className="i-dt" cx="3" cy="19" r="1.5" />
    </>
  ),
  undo: (
    <>
      <path d="M8.5 13.5 4 9l4.5-4.5M4 9h10.5a5.5 5.5 0 0 1 0 11H8" />
    </>
  ),
  redo: (
    <>
      <path d="M15.5 13.5 20 9l-4.5-4.5M20 9H9.5a5.5 5.5 0 0 0 0 11H16" />
    </>
  ),

  // around the features
  flip: (
    <>
      <path d="M8 20V5M5 8l3-3 3 3" />
      <path className="i-a" d="M16 4v15M13 16l3 3 3-3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12C5.5 6.5 9 5 12 5s6.5 1.5 9.5 7c-3 5.5-6.5 7-9.5 7s-6.5-1.5-9.5-7Z" />
      <circle className="i-f" cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path className="i-ft" d="M2.5 12C5.5 6.5 9 5 12 5s6.5 1.5 9.5 7c-3 5.5-6.5 7-9.5 7s-6.5-1.5-9.5-7Z" />
      <path d="M4.5 19.5 19.5 4.5" />
    </>
  ),
  exportStep: (
    <>
      <path className="i-g" d="m6 13.5 6-2.5 6 2.5v6L12 22l-6-2.5Z" />
      <path d="m6 13.5 6 2.5 6-2.5M12 16v6" />
      <path className="i-a" d="M12 9.5V1.5M9.3 4.2 12 1.5l2.7 2.7" />
    </>
  ),
  compare: (
    <>
      <path d="M3 17c5-8.5 13-8.5 18 0" />
      <path className="i-a" d="M6.3 9.6v3.4M10.06 8.6v2.2M13.94 13.4v-2.2M17.7 9.2v3.5" />
      <circle className="i-dt" cx="6.3" cy="9.6" r="1.05" />
      <circle className="i-dt" cx="10.06" cy="8.6" r="1.05" />
      <circle className="i-dt" cx="13.94" cy="13.5" r="1.05" />
      <circle className="i-dt" cx="17.7" cy="9.2" r="1.05" />
    </>
  ),
  curvature: (
    <>
      <path d="M3 5.5c2.5 9.5 8 13 18 13" />
      <circle className="i-a" cx="13" cy="10" r="6" />
      <circle className="i-adt" cx="13" cy="10" r="1.3" />
    </>
  ),

  // measure: the element types
  elPoint: (
    <>
      <path d="M12 2.5V7M12 17v4.5M2.5 12H7M17 12h4.5" />
      <circle className="i-a" cx="12" cy="12" r="4.6" />
      <circle className="i-adt" cx="12" cy="12" r="1.7" />
    </>
  ),
  elLine: (
    <>
      <path className="i-a" d="M3 19 21 5" />
      <circle className="i-dt" cx="6" cy="15" r="1" />
      <circle className="i-dt" cx="9.5" cy="15.5" r="1" />
      <circle className="i-dt" cx="12.4" cy="10.4" r="1" />
      <circle className="i-dt" cx="15.3" cy="10.9" r="1" />
      <circle className="i-dt" cx="18.4" cy="5.8" r="1" />
    </>
  ),
  elPlane: (
    <>
      <path className="i-f" d="M2.5 17.5 8.5 6.5h13l-6 11Z" />
      <circle className="i-dt" cx="9" cy="14.5" r="1" />
      <circle className="i-dt" cx="12.5" cy="10" r="1" />
      <circle className="i-dt" cx="16" cy="13" r="1" />
      <circle className="i-dt" cx="12.5" cy="14.8" r="1" />
      <circle className="i-dt" cx="17" cy="9.3" r="1" />
    </>
  ),
  elSphere: (
    <>
      <circle className="i-f" cx="12" cy="12" r="8.5" />
      <path className="i-a i-th" d="M3.5 12a8.5 3.2 0 0 0 17 0" />
      <circle className="i-dt" cx="8.5" cy="7.5" r="1" />
      <circle className="i-dt" cx="15" cy="8.5" r="1" />
      <circle className="i-dt" cx="11" cy="17.8" r="1" />
      <circle className="i-dt" cx="17" cy="15.5" r="1" />
    </>
  ),
  elCylinder: (
    <>
      <path className="i-f" d="M6 6.5v11a6 2.5 0 0 0 12 0v-11Z" />
      <ellipse className="i-f" cx="12" cy="6.5" rx="6" ry="2.5" />
      <circle className="i-dt" cx="9" cy="12" r="1" />
      <circle className="i-dt" cx="14" cy="13.5" r="1" />
      <circle className="i-dt" cx="10.5" cy="16.5" r="1" />
      <circle className="i-dt" cx="15.3" cy="11" r="1" />
    </>
  ),
  elCone: (
    <>
      <path className="i-f" d="M12 3 4 18.5a8 2.8 0 0 0 16 0Z" />
      <path className="i-a i-th i-ds" d="M4 18.5a8 2.8 0 0 1 16 0" />
      <circle className="i-dt" cx="11" cy="10.5" r="1" />
      <circle className="i-dt" cx="13.5" cy="14" r="1" />
      <circle className="i-dt" cx="9" cy="16.5" r="1" />
    </>
  ),
  elCircle: (
    <>
      <circle className="i-a" cx="12" cy="12" r="8" />
      <path className="i-a i-th" d="M10.5 12h3M12 10.5v3" />
      <circle className="i-dt" cx="12.3" cy="3.4" r="1" />
      <circle className="i-dt" cx="18.3" cy="6.5" r="1" />
      <circle className="i-dt" cx="19.5" cy="13.5" r="1" />
      <circle className="i-dt" cx="14.5" cy="20" r="1" />
      <circle className="i-dt" cx="6.5" cy="18.3" r="1" />
      <circle className="i-dt" cx="3.6" cy="11" r="1" />
      <circle className="i-dt" cx="6.3" cy="5.8" r="1" />
    </>
  ),
  elTorus: (
    <>
      <path className="i-f" fillRule="evenodd" d="M3 12a9 5.5 0 1 0 18 0a9 5.5 0 1 0-18 0ZM8.4 11a3.6 1.6 0 1 0 7.2 0a3.6 1.6 0 1 0-7.2 0Z" />
      <circle className="i-dt" cx="6" cy="10.5" r="1" />
      <circle className="i-dt" cx="17.5" cy="14" r="1" />
      <circle className="i-dt" cx="11" cy="15.5" r="1" />
      <circle className="i-dt" cx="16" cy="8.8" r="1" />
    </>
  ),
  section: (
    <>
      <path className="i-g" d="M7 5v14a5 2 0 0 0 10 0V5Z" />
      <ellipse className="i-g" cx="12" cy="5" rx="5" ry="2" />
      <path className="i-f" fillOpacity=".8" d="M2 15 6.5 9.5H22L17.5 15Z" />
      <ellipse className="i-a" cx="12" cy="12.25" rx="5" ry="1.9" />
    </>
  ),

  // 2D measure
  spline: (
    <>
      <path d="M3 17C7 5 10 5 12 12s5 7 9-5" />
      <circle className="i-adt" cx="3" cy="17" r="1.7" />
      <circle className="i-adt" cx="7.7" cy="8.3" r="1.7" />
      <circle className="i-adt" cx="12" cy="12" r="1.7" />
      <circle className="i-adt" cx="16.3" cy="15.7" r="1.7" />
      <circle className="i-adt" cx="21" cy="7" r="1.7" />
    </>
  ),
  // the things counted in a row, and the running number over each: 1 2 3
  count: (
    <>
      <circle className="i-g" cx="4.5" cy="18" r="2.6" />
      <circle className="i-g" cx="12" cy="18" r="2.6" />
      <circle className="i-g" cx="19.5" cy="18" r="2.6" />
      <path className="i-a" d="M3.2 5.8 5.2 4v7.6" />
      <path className="i-a" d="M9.9 5.9a2.1 2.1 0 1 1 3.7 1.5L9.8 11.6h4.4" />
      <path className="i-a" d="M17.5 4h4l-2.4 3.1a2.3 2.3 0 1 1-2 3.5" />
    </>
  ),
  note: (
    <>
      <path className="i-g" d="M3 4.5h18v12H11l-4 4v-4H3Z" />
      <path className="i-a" d="M7 8.5h10M7 12.5h6" />
    </>
  ),
  rotateCcw: (
    <>
      <path d="M6.7 7.2A7.5 7.5 0 1 1 4.5 12.5" />
      <path className="i-a" d="M6.7 2.7v4.5h4.5" />
    </>
  ),
  rotateCw: (
    <>
      <path d="M17.3 7.2A7.5 7.5 0 1 0 19.5 12.5" />
      <path className="i-a" d="M17.3 2.7v4.5h-4.5" />
    </>
  ),
  mirrorTB: (
    <>
      <path className="i-g" d="M5 9h14V3Z" />
      <path className="i-f" d="M5 15h14v6Z" />
      <path className="i-a i-ax" d="M1.5 12h21" />
    </>
  ),

  // marking the surface
  navigate: (
    <>
      <path d="M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5" />
    </>
  ),
  pickPoints: (
    <>
      <circle className="i-a" cx="7" cy="7" r="3.6" />
      <circle className="i-adt" cx="7" cy="7" r="1.6" />
      <path className="i-g" d="M11 10v11l2.9-2.5 2 4.3 1.9-.9-2-4.2 3.9-.3Z" />
    </>
  ),
  markWindow: (
    <>
      <rect className="i-f i-ds" x="3" y="5" width="16" height="12" />
      <circle className="i-adt" cx="3" cy="5" r="1.7" />
      <circle className="i-adt" cx="19" cy="17" r="1.7" />
    </>
  ),
  markBrush: (
    <>
      <path className="i-as" strokeWidth="8" d="M5.5 17.5Q9 10.5 16 8" />
      <circle className="i-a" cx="16" cy="8" r="4" />
      <circle className="i-dt" cx="16" cy="8" r="1.1" />
    </>
  ),
  markLasso: (
    <>
      <path className="i-f i-ds" d="M12 4c5 0 9 2.5 9 6.5S17 17 12 17c-2 0-3.5-.3-5-1-2.5-1.2-4-3-4-5.5C3 6.5 7 4 12 4Z" />
      <path d="M7 16c-1.8 1.3-2 3.3-.5 5" />
      <circle className="i-adt" cx="7" cy="16" r="1.7" />
    </>
  ),
  erase: (
    <>
      <path className="i-g" d="M14.5 4 20 9.5 11.5 18H7l-3.5-3.5Z" />
      <path d="m9 9.5 5.5 5.5" />
      <path className="i-a i-ds" d="M4 21.5h16" />
    </>
  ),

  // a row of the lists
  edit: (
    <>
      <path className="i-g" d="m4 20 1-4.5L16.5 4 20 7.5 8.5 19Z" />
      <path d="m14 6.5 3.5 3.5" />
    </>
  ),
  bin: (
    <>
      <path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13.5h9l1-13.5" />
    </>
  ),

  // the view bar
  labels: (
    <>
      <path className="i-g" d="M3 5.5h10.5l7.5 6.5-7.5 6.5H3Z" />
      <circle className="i-adt" cx="7.5" cy="12" r="1.7" />
    </>
  ),
  splitView: (
    <>
      <rect className="i-g" x="3" y="5" width="18" height="14" rx="1.5" />
      <path className="i-a" d="M12 5v14" />
    </>
  ),
  colourPlot: (
    <>
      <path className="i-g" d="M4 13c0-5 3-9.5 8.5-9.5S21 7 20.5 12 17 20.5 11.5 20.5 4 18 4 13Z" />
      <path className="i-f" d="M8 13.5C8 10.5 10 8 13 8s4.5 2 4.5 4.5S15.5 17 12.5 17 8 16 8 13.5Z" />
      <circle className="i-adt" cx="13.5" cy="12" r="1.7" />
    </>
  ),
  model: (
    <>
      <path className="i-g" d="M4 9h11v11H4Z" />
      <path className="i-g" d="m4 9 5-5h11l-5 5Z" />
      <path className="i-g" d="m15 9 5-5v11l-5 5Z" />
    </>
  ),
  slice: (
    <>
      <path className="i-th i-ft i-ds" d="M4 14V9l5-5h11v5M4 9h11l5-5M15 9v5" />
      <path className="i-g" d="M4 14h11v6H4Z" />
      <path className="i-g" d="m15 14 5-5v6l-5 5Z" />
      <path className="i-f" d="m4 14 5-5h11l-5 5Z" />
    </>
  ),
  scan: (
    <>
      <circle className="i-dt" cx="12" cy="4" r="1.15" />
      <circle className="i-dt" cx="7" cy="6.5" r="1.15" />
      <circle className="i-dt" cx="17" cy="6.5" r="1.15" />
      <circle className="i-dt" cx="4.5" cy="11.5" r="1.15" />
      <circle className="i-dt" cx="9.5" cy="10.5" r="1.15" />
      <circle className="i-dt" cx="14.5" cy="10.5" r="1.15" />
      <circle className="i-dt" cx="19.5" cy="11.5" r="1.15" />
      <circle className="i-dt" cx="7" cy="16" r="1.15" />
      <circle className="i-dt" cx="12" cy="15" r="1.15" />
      <circle className="i-dt" cx="17" cy="16" r="1.15" />
      <circle className="i-dt" cx="12" cy="20" r="1.15" />
    </>
  ),
  opaque: (
    <>
      <path className="i-f" d="M4 9h11v11H4Z" />
      <path className="i-f" d="m4 9 5-5h11l-5 5Z" />
      <path className="i-f" d="m15 9 5-5v11l-5 5Z" />
    </>
  ),
  transparent: (
    <>
      <path className="i-th i-ft i-ds" d="M9 4v11h11M9 15l-5 5" />
      <path d="M4 9h11v11H4Zm0 0 5-5h11l-5 5m5-5v11l-5 5" />
    </>
  ),
  mesh: (
    <>
      <path className="i-g" d="m3 17 5-11 9-2 4 9-7 8Z" />
      <path className="i-th" d="m12 12-9 5m9-5L8 6m4 6 5-8m-5 8 9 1m-9-1 2 9" />
      <circle className="i-adt" cx="12" cy="12" r="1.7" />
    </>
  ),
  backfaces: (
    <>
      <path className="i-g" d="M2.5 14 8 5.5h13.5L16 14Z" />
      <path className="i-a" d="M12 10v11M9.5 18.5 12 21l2.5-2.5" />
    </>
  ),

  // the top bar
  save: (
    <>
      <path className="i-g" d="M4 4h12.5L20 7.5V20H4Z" />
      <path d="M8 4v5h7V4" />
      <rect className="i-a" x="7.5" y="13" width="9" height="7" />
    </>
  ),
  load: (
    <>
      <path className="i-g" d="M3 19V5h6l2 2.5h8V11" />
      <path className="i-f" d="m3 19 3-8h16l-3 8Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="8.2" strokeWidth="3" strokeDasharray="3.22 3.22" strokeLinecap="butt" />
      <circle cx="12" cy="12" r="6.4" />
      <circle className="i-a" cx="12" cy="12" r="2.6" />
    </>
  ),
  wsMeasure: (
    <>
      <circle className="i-f" cx="6" cy="16.5" r="3.5" />
      <circle className="i-f" cx="18" cy="16.5" r="3.5" />
      <path className="i-th" d="M6 12.5V4.5M18 12.5V4.5" />
      <path d="M6 7h12M8 5 6 7l2 2M16 5l2 2-2 2" />
    </>
  ),
  wsThickness: (
    <>
      <path className="i-gf" d="M3 8c6-3 12-3 18 0v9c-6-3-12-3-18 0Z" />
      <path d="M3 8c6-3 12-3 18 0M3 17c6-3 12-3 18 0" />
      <path className="i-a" d="M12 6.5V14M10 8.5l2-2 2 2M10 12l2 2 2-2" />
    </>
  ),
  wsMesh: (
    <>
      <path className="i-g" d="M3 18 6 7l8-3 7 5-2 10Z" />
      <path className="i-a" d="M11 13 3 18m8-5L6 7m5 6 3-9m-3 9 10-4m-10 4 8 6" />
    </>
  ),
  // Reduce: the scan's triangles, fine where they were and few and
  // large where the reduction took them; the part with the specks it came
  // with, which the key takes off.
  reduceMesh: (
    <>
      <path className="i-g" d="M3 4h18v16H3Z" />
      <path className="i-th" d="M6 4v16M3 8h6M3 12h6M3 16h6" />
      <path className="i-a" d="M9 4v16L21 4" />
    </>
  ),
  islands: (
    <>
      <path className="i-g" d="M3 20 4.5 11 11 8l5 4.5-1.5 7.5Z" />
      <circle className="i-a" cx="18.5" cy="5.5" r="1.6" />
      <circle className="i-a" cx="18.5" cy="5.5" r="3.6" />
      <circle className="i-a" cx="12.5" cy="3.5" r="1" />
      <circle className="i-a" cx="20.5" cy="12.5" r="1" />
    </>
  ),
  // The part, and a patch of it lassoed and struck through — what goes.
  deleteSurface: (
    <>
      <path className="i-g" d="M3 20V9l6-5h12v16Z" />
      <path className="i-f i-ds" d="M12 9.5c3 0 5.5 1.2 5.5 3.5S15 16.5 12 16.5 6.5 15.3 6.5 13 9 9.5 12 9.5Z" />
      <path className="i-a" d="m9.5 11 5 4.5m0-4.5-5 4.5" />
    </>
  ),
  // A face with a hole in it, and the patch across the hole.
  fillHoles: (
    <>
      <path className="i-g" d="M3 5h18v14H3Z" />
      <circle className="i-f" cx="12" cy="12" r="4" />
      <path className="i-th" d="M8.5 10 12 8l3.5 2m-7 4 3.5 2 3.5-2M12 8v8" />
    </>
  ),
  // A jagged profile, and the smooth one drawn through it.
  smoothMesh: (
    <>
      <path className="i-th i-ft" d="m2.5 16 2-3 2 2.5 2-4.5 2 3.5 2-5 2 4 2-5 2 3.5 2-3 1.5 1.5" />
      <path className="i-a" d="M2.5 15.5C7 14 12 11 21.5 9.5" />
      <path className="i-g" d="M2.5 20h19" />
    </>
  ),
  wsFlat: (
    <>
      <rect className="i-g" x="3" y="3.5" width="18" height="13" rx="1.5" />
      <circle className="i-a" cx="12" cy="10" r="3.5" />
      <path d="M3 20.5h18" />
      <path className="i-th" d="M6 20.5v-1.8M10 20.5v-1.8M14 20.5v-1.8M18 20.5v-1.8" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof ICONS

/** One of the set, 24 px unless told otherwise. Decoration only: the key
 *  that carries it says what it is through its label, title or aria-label.
 *  At 16 px and under the stroke is drawn heavier, or it falls below a pixel. */
export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg className={size <= 16 ? 'icon small' : 'icon'} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  )
}
