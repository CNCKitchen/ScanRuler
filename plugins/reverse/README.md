<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reverse engineer

The Reverse engineer workspace, as a plugin — see [../README.md](../README.md)
for what a plugin is. What follows is the workspace's chapter of the app's
documentation.

## Reverse engineer: from scan to a solid STEP body

The fourth workspace turns the scan into a **solid body** — a closed B-rep in
a STEP file that FreeCAD and Fusion open as a body, not the analytic datums
the 3D Measure workspace exports. It is built the way every reverse-engineering
tool builds a prismatic part: sketch the profile on a section through the
scan, close it, extrude or revolve it, and check it against the scan. It is
not a CAD system; it is the dozen operations that get from a scan to a part.

Modelling runs on [Open CASCADE Technology](https://dev.opencascade.org/)
compiled to WebAssembly, fetched (5 to 7 MB compressed, 22 MB unpacked) in its own worker the first
time the workspace is opened. It needs a browser with WebAssembly tail calls
— Chrome 114, Safari 17.2, Firefox 121 or later; an older one is told so in
the panel and keeps every other workspace.

**No scan is needed to model.** With no scan loaded the workspace opens
straight on a blank stage sized for a part the size of a hand — there is no
front door to pass — and the sketch, extrude, revolve, fillet, chamfer, shell, hole,
mirror, pattern, combine and STEP export work as in any CAD program — only
what reads the scan (Fit surface, Trim, Snap to scan, the slice under a sketch,
the deviation map) waits for one. The stage follows the bodies as they grow,
the project saves and opens with features and no scan in it, and a scan
loaded later joins the model instead of replacing it. The XY, XZ and YZ
planes stand at the origin on the blank stage, listed at the head of the
body list with eyes of their own (over a scan they start hidden); a click
on one in the viewport offers a sketch on it.

**What is picked says what it is.** With no editor open, a click on a body
takes a **face**, an **edge** or a **corner**, and the chips by the click
read it: a face its area and normal (a round one its radius and axis), an
edge its length and ends (a round one its radius and centre), a corner its
coordinates. **Ctrl+click adds** a second pick and the chips read what lies
between the two — the distance between two corners with its ΔX, ΔY and ΔZ,
from a corner to an edge, an axis or a face, between parallel faces or
edges, the angle between those that are not, the distance between two
holes' axes — and, of more, the lengths and areas together. Several edges
of one body offer Fillet and Chamfer on all of them, several faces Move faces and
Shell.
**Shift+drag draws a selection window** — to the right it takes what lies
wholly inside (a solid box), to the left what it touches as well (a dashed
one), hidden edges included, as CAD's window selection does — into the
selection, or into the open Fillet, Chamfer, Shell or Draft: a window round
the part picks every edge for a fillet all round.

**The body list is an assembly's browser.** The pointer on a body's row
lights the body in the viewport — in blue over everything, so a part
inside another shows where it is — and the cursor on a body in the
viewport lights its row. A click on a body heads the readings with the
part it is on and its component, and keys to **Hide** it or **Hide
others** (then **Show all**); picks on several parts offer **Make
component**. **Components** sort the bodies: the label's **Component** key
makes one, a body or a component dragged onto it goes in, dropped on the
strip under the list it comes out; a right click on a row offers the same
moves and Hide others. A component's eye shows or hides all it holds, its
fold closes it — its row then lights for the parts inside — and a double
click renames it. They are saved with the project and undone like the
features; nothing is built from them. **Several rows** are picked as in a
file browser — a click, **Ctrl+click** for one more, **Shift+click** for
every row up to it — lit in the viewport and dragged together; the keys
under the list **Move** them all at once, make a **Component** of them or
**Hide others**. While a Move is open, a click on a row puts that body into
the Move or takes it out.

### How to use it

1. Load the scan and **align it** in the 3D Measure workspace — a 3-2-1
   alignment onto fitted planes — so the part stands square. The body is
   built in whatever frame the part is in.
2. Choose the plane to sketch on in the panel's **Sketch on** list: a
   **section** cut through the part where the profile is (Elements →
   Section), a fitted plane, a coordinate plane (XY, XZ, YZ, at zero, once
   the part is aligned or there is no scan) or a coordinate plane through
   the scan's centre — hovering an entry shows that plane on
   the part with its name, so "Plane 2" is a place before it is a choice.
   Whatever the plane, the sheet's zero is the part's origin projected
   onto it and its X a coordinate axis, as FreeCAD, Fusion, Onshape and
   SolidWorks have it: a dot in the datum colour marks the origin, the
   tools snap to it, the grid is anchored on it, and the part's coordinate
   planes cross the sheet there as the lines a dimension can be taken to.
   The elements and sections measured in the 3D Measure workspace are drawn on
   the part here as well, as the datums the model is built against; the view
   bar's **Elements** key puts them away. The sketch opens on the 2D sheet,
   with the slice the plane cuts through the scan drawn as edge chains over
   a millimetre grid whose spacing follows the zoom — **on the part**, the
   way CAD sketches: the part turns to face the sketch plane, a short swing
   from wherever the camera was, so it is plain where the plane sits — and
   swings back to that view when the sketch is put away — and
   is **cut open at the plane** where the plane runs through it, the cut
   closed with a solid cap in a flat slate tone the drawing reads
   against — the slice a hairline over it, the pieces in colour with a dot
   on every end — so the face being drawn on is the face in
   view, with the plane's outline and
   the sketch's name on it. The part follows every pan and zoom of the
   sheet. Three keys on the view bar say what of the part lies under the
   sketch: **No part**, the sheet on the bare stage; **Section**, the part
   cut open as above, the solid bodies closed where they are cut, each in
   its own cut colour, as the section view closes them; **Full part**, the
   whole part, nothing cut away. A part modelled with no scan is cut as a
   scan is.
3. **Fit all chains** cuts every chain into lines and arcs and joins their
   corners, so a closed slice comes out a closed profile in one click; each
   piece keeps its slice points, and the solver holds it to them from then
   on. A wall that bows or wanders by several times the scan's noise is one
   line, a fillet stays a fillet beside it, a blob in a corner — weld
   spatter, dirt — is cut out for the corner its sides make, and the riser
   of a small step stays a line. **Fit options…** opens a window beside the
   box: a **Detail** slider from coarse (few, long pieces) to fine (every
   small feature its own piece), the *Fit tolerance*, whether the fit joins
   the corners, and **Align lines to the sheet's axes** — lines within a few
   degrees of level or upright (and of 45°, if asked) are laid along them,
   with an inferred relation one click takes off, and the pieces of one
   wall become one line. A change in the window refits the chains already
   fitted, as one step for Ctrl+Z; the options are remembered. **Infer
   corners** joins ends that lie within 2 mm of each other and adds a
   tangency where a line runs into a fillet — for a fit made with joining
   off, or pieces drawn since; **Close** bridges whatever gap is left — two
   lines are carried on to their intersection, anything else gets a
   straight bridge.
4. Draw what the scan did not give you with the **Line, Rectangle,
   Polygon, Circle and Arc** tools — the cursor is a crosshair, the shape follows it between
   the clicks, as it does in CAD, and every click snaps: to an end already
   there (a cross; the new end is held to it), to a piece drawn or
   projected (held on it), to a point of the slice (a diamond), to a piece
   fitted to the slice — and to the grid (a square) once **Snap to grid**
   by the tools is switched on; off, which is the default, the grid is only
   there to read against. Hold **Ctrl** to place a point exactly where the
   cursor is, as in Fusion. The **Line** tool (L) draws a **chain**: each
   line starts where the last ended, and a press on that end, dragged,
   swings out an **arc tangent** to the piece before it; Escape, Enter, a
   second click on the last end or landing on another piece's end ends
   the chain. R and C take the rectangle and the circle. The rectangle, the
   circle and the arc each draw more than one way — two corners, the centre
   and a corner, or one side and the far side at any angle; the centre and
   the rim, a diameter, or three points on the rim; three points, or the
   centre, the start and the end. Rest the cursor on the key and its ways
   open beneath it as pictures; the one picked becomes the key's picture,
   the way that key draws until another is picked. The **Polygon** draws a
   regular polygon of the sides set under the keys, from its centre and a
   corner, or from its centre and the middle of a side — sized across its
   flats, as a hex nut is: its corners on a construction circle, its sides
   **Equal** (a relation of its own too: two lines of one length, two round
   pieces of one radius), fully defined by the circle's centre, its radius
   and one turn. The **Spline** tool (S) draws a smooth curve through the
   points clicked, following the cursor. Click the last point again (or
   double-click it), or press Enter or Escape, to end it open; click the
   first point to close it round. Every fit point snaps as it is clicked,
   is dragged to bend the curve, and takes relations and dimensions like
   an end. Joined at an end to a line, an arc or another spline, it can be
   made **Tangent** there. With a spline selected, **Fit spline to slice**
   takes the slice points along it as its soft data, and the solver
   settles the curve onto them; add points where the outline bends more
   than the curve follows. The part gets the curve itself: one smooth
   B-spline edge, as in the STEP. **Pattern**, by the edit keys, repeats the selected pieces
   in a row, a grid or round a centre, the copies shown on the sheet until
   applied; each keeps the relations and dimensions the pieces have among
   themselves. **Picture…** lays a photo or a drawing under the sketch to
   trace — brought to scale by two points on it a known length apart, moved
   by a point and where it belongs, levelled by two points that should lie
   level, and faded; it is saved with the sketch. The plane the sketch lies
   on takes an offset under its name — a coordinate plane's coordinate, how
   far off a face, a measured plane or a section — as a number or an
   expression the sketch then follows. The sheet has no
   edge: the card it is framed by reaches a little past the slice, and a
   click beyond it — a rectangle drawn wider than the part — lands on the
   plane all the same. A line drawn
   within 3° of level or upright is
   made so, and the relation shows as a chip under the tools that one
   click takes off. With the **Select** tool, **drag** an
   end, a centre or a whole piece to move it; the dragged point snaps the
   same way, the constraints hold — an end of a horizontal line slides
   along it — and a point dropped on another piece's end is joined to it. A
   line dragged by its body moves **square to itself**, however the hand
   goes — along its own length there is nothing to move it to — and Ctrl
   moves it freely. A
   fitted piece dragged by hand lets go of its slice points. A drag that
   starts on the bare sheet draws a **selection box** instead of panning:
   dragged to the right a solid window that takes the pieces lying wholly
   inside it, to the left a dashed crossing box that takes every piece it
   touches — lit while it is dragged — with Shift or Ctrl held adding them
   to the selection. The right button pans; with a drawing tool in hand a
   left-drag pans as before. **Align** turns
   the sheet so the selected line lies along its X axis, with the frame
   turning underneath, so a crooked edge of the scan becomes the horizontal
   the rest is drawn against. **Dimension** — the first key of the row,
   or **D** — takes what is clicked next: a line for its length, an arc for
   its radius, a full circle for its **diameter** (Ø), as a drawing gives a
   hole or a boss; a second piece or an end for what lies between
   the two — the distance between parallel lines, the angle between
   others, the distance from an end or a centre to a line or to another
   point. The new dimension's number then **follows the cursor**, as in
   Onshape: a click puts it down where it reads best and opens it there for
   typing, Enter puts it where the layout has it, and Escape takes it back.
   While a line's length, a radius or a diameter follows the cursor, a click on another
   piece, an end or a plane's line makes it the distance or the angle
   between the two instead; only those are lit. On the sheet a dimension is drawn as a drawing carries it, the way
   Onshape does: extension lines off the two measured points, a dimension
   line with a filled arrow at each end — turned in from outside on a
   stretch too short for them — and the number written along the line in a
   gap left for it; a radius is a leader with its arrow on the rim, a
   diameter a line through the centre with an arrow on the rim at each end,
   an angle an arc between the two lines. A round piece's number typed with
   its letter — **Ø12** over an R, **R6** over a Ø — gives it that way, and
   its row's **→ Ø** or **→ R** chip turns it over with the size held. **Drag the number** to where it reads
   best — off the line, along it, past its end, round a circle, across an
   angle's vertex — and it keeps that place against the pieces it measures
   as they move; a click on it opens it for typing. The **relations** — join, horizontal, vertical, parallel,
   perpendicular, tangent, concentric, symmetric — work the same way, on
   the pieces clicked next; with pieces selected beforehand either goes on
   the selection. Their glyphs stay off the drawing until the eye key by
   the tools asks for them. What a tool would take is **lit under the
   cursor** before the click, as CAD lights it: the piece for the arrow and
   for a relation, the piece, end or plane's line for a dimension, both
   lines of a corner for a round or a chamfer — heavier than the selection
   and a tone lighter. Pointing at a relation's glyph or a dimension's
   number lights it, and the pieces and ends it holds. Beside every measured number a
   chip offers the **round value** it was probably designed at — halves
   under 10 mm and whole millimetres above, radii to the half, angles to
   5° — one click to take it. Every relation and dimension is met
   exactly; the slice points settle the rest. A dimension the geometry cannot
   meet is reported as unmet, not split down the middle, and a relation that
   says nothing new is counted as redundant. **Symmetric** takes three
   picks, and the line under the tools says which comes next: the two
   pieces that mirror each other, then the **line they mirror about** — a
   centre line, drawn and made Construction, or one of the part's
   coordinate planes, clicked on the line it cuts the sheet in. Two lines
   are held end for end, whichever way each was drawn, circles by their
   centres, arcs by both; with the two pieces selected beforehand the key takes the relation
   in hand and the next click is the mirror line. **Fillet** (F) and
   **Chamfer** sit with the drawing tools: click a corner, or one line and
   then the other. A fillet comes out with its radius as a dimension, a
   chamfer with its two distances — alike for an even one, typed apart for
   an uneven one — and the next starts with the last size. **Sharp corner**
   removes a fillet arc or a chamfer's line and carries its two sides to
   the corner.
5. Every closed region is filled faintly, and the box's status reads
   **Needs input** or **Solved** — the solver's own words wait in the
   tooltip. The moment a region closes the box offers **Extrude** and
   **Revolve**, which finish the sketch and open the feature on it with
   that region picked. **Finish sketch** — the key at the top or the bottom
   of the box, Enter or a **middle click**, as everything in the tool is
   confirmed — keeps the drawing as a feature for later, drawn on the part
   in its plane. Escape only puts the tool down; there is no Cancel. A
   sketch you did not want is taken back with **Ctrl+Z** from the feature
   list (Ctrl+Shift+Z or Ctrl+Y brings it again), and Finish on an empty
   sketch makes nothing.
6. **Extrude** or **Revolve**, the way Fusion and Onshape do it: the
   sketch's closed regions show on the part as faces — click the ones to
   use (a sketch with one region has it picked already; an inner loop left
   unpicked becomes a hole), and the body appears as a **ghost** with an
   **arrow on each face** to drag the distance and one on the far edge to
   lean the sides, or a **ring** about the axis to drag the angle. The
   arrows keep their size on the screen at any zoom — a small face they
   stand on stays in view. A **field on the grip**, off the arrow's tip, shows the number while it is
   dragged and takes typing once the hand lets go — Enter commits, Escape
   closes it. The numbers in the box follow the grips and the grips
   follow the numbers, the box reads the ghost's volume as it changes, and
   From, To, Total and Angle offer their round values as chips. An
   extrude reaches by a distance either side of its plane, up to a plane,
   between two planes, or symmetrically — the plane lists show the plane
   under the cursor on the part — or to what is there on the part: **to a
   face of a body**, a flat one clicked in the viewport; **to next**, until
   the profile first meets the body it joins or cuts (the whole profile has
   to land on the body — one that would run on past it is refused), a cut
   going through the first wall it meets; **to last / through all**, to the
   body's far end, a cut a hair beyond. Reverse direction makes these two
   look the other way along the normal. All with a **taper**, as Fusion has
   it: positive leans the sides out as the body goes away from the sketch,
   negative leans them in (a moulded boss's draft) — typed in the box, or
   dragged with the arrow on the far edge. The sketch's outline stays the
   body's section at the sketch plane, or at the end of the extent nearest
   it; an extent reaching both ways leans both ways from the plane; an end
   on a plane or a face is reached leaning all the way to it. A taper that
   would close the profile, or a hole or a notch of it, before the far end
   is refused, saying how far it gets. **Direction** sweeps the profile
   askew of its plane — along a measured line or axis, a coordinate axis,
   or three numbers typed — an oblique prism whose ends stay parallel to the
   sketch: a leaning boss on a level sketch, the distances counted along
   it and a taper leaning the sides about it. **Reverse direction** turns
   the extrude over. With the extent a **Distance**, a **click on the part** —
   the scan, a body, a body's corner — puts an end of the extrude at the
   height of that point over the sketch plane: a point in front of the
   plane sets **To**, a point behind it sets **From**, so a click on the
   part's top and one on its bottom make the body that spans them, in
   either order (a part lying wholly behind the plane: put To at 0 by
   hand). A Symmetric extent reaches the point
   with either half. The height is
   read off the point once and is a number from then on. (A sketch region
   under the cursor still takes its click as a profile.) The ghost follows
   a dragged arrow **frame by frame**: a straight extrude's ghost is the
   last one the kernel built, stretched along the normal to the new
   numbers, and the kernel's own takes over as it lands — one request out
   at a time, the newest numbers asked for the moment the last answer is
   back;
   a revolve turns about a line element, a
   cylinder's axis or one of the sketch's own lines — click the line on the
   part to choose it, or hover the list and see the axis drawn across the
   part. Ticked **Coil**, the revolve climbs along its axis as it turns — a
   spring, a thread, a worm: the **pitch** is how far each turn climbs, and
   the angle runs on past 360° for as many turns as asked, typed as
   degrees, as **turns** or as a **height**, or the ring wound round and
   round. **Left-handed** turns it the other way; **Reverse direction**, or
   a negative pitch, climbs the other way along the axis. A coil starts with
   a pitch half again as long as the profile reaches along the axis, and
   three turns. A profile reaching as far along the axis as the pitch would
   run into its next turn, and one touching or crossing the axis has no
   helix to follow: both are refused. A thread is a groove's section drawn
   on a plane through the bar's axis, reaching a little past the bar,
   coiled with Result Cut. Each **joins** what it meets, **cuts** it, or makes a **new
   body** — no body is chosen, as in Fusion. A join is made one with every
   solid body it touches: a body of its own where it touches none, and one
   body of all of them where it bridges several, under the oldest one's
   name. A cut goes through every solid body it meets and fails, saying so,
   when it meets none. New body keeps the solid a body of its own whatever
   it overlaps — a tool to take out of the scan in Mesh Tools. One body is
   one solid: what a step leaves in pieces — two profiles apart, a bar cut
   through at its waist, a pattern's copies standing apart — is a body a
   piece. The feature's row says which bodies it joined or cut. Sheets and
   fitted surfaces are never joined or cut: they have no inside, and
   surfaces become a solid through **Trim**. A feature saved before this,
   with its body named, still joins or cuts that body alone until it is
   saved again from its box. A cut's ghost is red. Enter or a middle click creates the
   feature once it is ready; Tab walks from one number to the next. Once
   the feature is made its **sketch is hidden** — the eye on the sketch's
   row shows it again, and it is drawn whenever a feature made from it is
   open. While
   the ghost is up, the **deviation map** in the box colours the scan near
   it by how far it lies from the ghost's surface — green on it, red
   outside the body, blue inside, on the Deviation ramp at ± the range in
   the box (0.1 mm to start, remembered), a darker cap past either end,
   and the scan further than ten ranges from the ghost left as it is. The
   box counts how many of the scan points near the ghost lie within the
   range and the legend beside the viewport reads the ramp; a click on the
   figure at either end of the legend's scale opens it to retype, and
   the number entered becomes the range both ways — 0.5 at the top or the
   bottom reads ±0.5 mm. The view bar's
   **Deviation** key reads the same map against the committed bodies, and
   there the scan that lies *deeper* inside the bodies than the reach is
   painted **violet** and counted in the legend: the scan is the part's
   skin, so a vertex deep inside the model is a hole, a pocket or a slot
   the bodies lack — the one error a ramp about the surface never shows.
   The view bar's **Bodies** key puts the bodies away as a whole with the
   map still on the scan (each body's own eye takes it out of the model
   and the map instead). Drag the arrow
   and watch the face go green as the ghost meets the scan; the switch in
   the box turns the map off.
7. The **features on a body**, picked on the part the way CAD picks them:
   with a box open the body's faces or edges light under the cursor and a
   click takes one, the bodies not in play dimmed. **Shell** hollows the
   body to a wall — click the faces to take away, the ends of a channel
   say, or none for a closed hollow body — with the wall the Thickness map's reading of the part when one
   was measured (2 mm otherwise), and an arrow on the opened face to drag
   it. **Fillet** and **Chamfer** round or cut the clicked edges, a round
   running on along the edges tangent to it; the fillet's radius is **read
   off the scan** across the first edge — a section square to the edge,
   the round between the two faces fitted as the circle tangent to both —
   and the box says what it found, or that the scan shows no round there.
   The fillet's **Radius** is **Constant** or **Variable**: variable, each
   edge clicked is listed with a **Start** and an **End** radius, the round
   running evenly from the one to the other, ⇄ swapping the two — and on
   the part each end is named Start or End, with its radius, beside a dot. The chamfer's **Type** is **Equal
   distance**, **Two distances** — the first on each edge's reference face,
   the second on the other — or **Distance and angle**, the chamfer at the
   angle to the reference face; the reference face is the one most of the
   edges share, a rim's top, and **Flip** takes the other. **Delete face**
   takes faces off the body and runs the faces round them on over the gap
   — a fillet, a chamfer, a hole or a boss out of a part, an imported STEP
   simplified: a click on a face takes the faces it is split from, the
   faces it closes in (a blind hole's floor, a boss's top) and, with
   **Tangent faces**, the rounds that run on from a round — a fillet's
   whole chain — and a second click lets all of that go.
   **Hole** drills along a cylinder or circle element, or a round face of
   the body, through or to a depth — or into a flat face at its centre, a
   standoff's top, its **Insert** list sizing it for a heat-set insert (CNC
   Kitchen's, M2 to M8 and ¼"-20: the hole, a millimetre deeper than the
   insert, the wall to leave); **Thread** cuts a modeled screw thread
   on a round face, as Fusion's does — a bolt's on a boss, a nut's in a
   bore, told apart by the way the face looks: **ISO metric** coarse and
   fine, **UNC** or **UNF**, or **3D printing — 45° flanks** (below), the
   size the face carries taken as it is
   clicked (a boss's major diameter; a bore's own where it is drawn at a
   size's — Ø5 for M5 — and its tap drill otherwise) until one is
   chosen, or a **diameter** and a **pitch** typed; right or left hand; the
   whole face (**Full length**) or a **length** from a **start** in from
   either end. The profile is the standards' basic one, a 60° vee flat at
   the crest and the root. The printing form is a profile of its own, made
   to be printed with the axis upright: the flanks at 45° to the radius
   (90° between them), so no face that looks down overhangs past 45°, and
   a flat crest and a flat root a fifth of the pitch each, upright when
   printed, with no round anywhere; 0.3 of the pitch deep. Its sizes are
   the ISO metric diameters from Ø3, each first at the pitch that cuts as
   deep as its ISO coarse thread — about 1.8 times as coarse, Ø10×2.75
   for M10×1.5 — so it keeps ISO's minor diameter, the core as strong and
   a bore at the tap drill's size taken for the same size; the ISO coarse
   pitch is the second, shallower choice. It mates only with itself.
   **Offset** is a clearance for printing: every
   face of the thread moved into the material by it — the flanks thinner,
   the crest lower, the root deeper — so a printed bolt turns into a
   printed nut. Small values only: past about a tenth of the pitch the
   60° crest comes to a point, and at √3/8 of the pitch (√2/8 in the
   printing form), where the tooth has nothing left at the pitch diameter,
   it is refused. A thread stops at a
   shoulder or a bore's floor and runs out past a free end. The face may be
   drawn any size: along the thread a bore is brought to the thread's minor
   diameter and a boss to its major — a wider bore filled in, a narrower
   boss built up, a narrower bore bored out, a wider boss turned down — so
   a Ø5 hole takes M5, M4 or M6 and a Ø4 pin M5; the box and the row say
   so where the face was off by more than the thread's depth. **Chamfer the free
   ends** cuts a 45° chamfer across the thread wherever it comes out of the
   body free — a bolt's tip, both mouths of a nut's bore — from a tenth of
   the pitch past the root (inside a bolt's minor diameter, outside a nut's
   major) out through the crests, so the thread starts clean instead of on
   a knife-edge first turn; it is refused where the thread comes out free
   nowhere; **Extract** makes a body of a measured
   plane (a slab), cylinder, cone or sphere at its fitted extents and its
   Assumed Ø, as Measure draws it — a body of its own to start with — and
   puts the element out of view, the two
   drawn over each other making a click on either a guess (Measure's eye
   brings it back); **Cut
   by plane** keeps one side; **Mirror** doubles the body about a plane or
   a flat face; **Combine** joins, cuts or intersects two bodies — a tool
   body a later step left in pieces goes in with all of them, so a plug
   patterned into copies apart cuts every window, and **Keep the tool
   body** leaves the tool standing beside the result, as it was. Two
   profiles extruded together are combined either way round. Every
   pick is stored as a **fingerprint** of the face or edge — its kind,
   middle, direction, size and the feature that made it — and found again
   on the rebuilt body after an earlier dimension moves; a pick that is
   gone fails its feature by name, and the rest still build. A feature
   reopened for editing shows the body as it stood before it, with its
   picks lit where they were made. The **cutter operations** of the
   surface route: **Sheet** extrudes a sketch's pieces — an open chain
   will do — as a surface, a body of its own marked as a surface and never
   exported alone, and the live map colours the scan against it; **Split**
   cuts a body by one or more sheets and keeps the fragments **that lie on
   the scan** (their surface sampled against it by area, within a
   tolerance, over an overlap share — the plug of a window has its walls
   on the scan and its roof and floor on nothing, and falls out), or the
   largest or the smallest; **Loft** runs a solid through the profiles of
   two or more sketches, straight or smooth; **Sweep** carries one sketch's
   largest region along another sketch's chain of lines and arcs — a bent
   bar, a handle, a rim that follows a curve — its section square to the
   path, the profile sketched on a plane square to the path where it
   starts; **Pattern** copies a body
   about an axis or along a direction, and along a second direction for a
   grid — a sheet too, the one feature a sheet takes: one window's outline
   patterned four times round a wheel is one sheet of four cutters to split
   with. **Offset body** grows a body all round by a distance, or shrinks
   it — kept beside it as a body of its own, a keep-out round a bought-in
   part that **Combine**'s Cut, the tool kept, turns into the pocket that
   holds it with clearance. Picks on two bodies offer **Clearance**: how
   far apart they stand at the closest, or the volume they share. Two
   bodies that **run into each other** show what they share in hatched red
   over both — where their faces lie on one another, as two flush tops do,
   the red stands in for two colours fighting over the same pixels; it
   shows inside see-through bodies and on the section view's cut too.
   Bodies that only touch share nothing, and the scan the bodies are
   modelled in is never counted. **Overlaps** in the menu over the view
   bar's **Bodies** key turns it off for bodies that overlap on purpose —
   a modifier volume for a slicer — and the project keeps it off.
   **Draft** leans faces about a neutral plane: click the flat face that
   stays — the one the part stands on in its mould — or choose a plane,
   then the faces to lean, and type the angle; they lean in as they go
   into the body, out for a negative angle. Fillet and Chamfer carry a
   **Tangent propagation** switch, on to start, and the edges the chain
   will reach light in a lighter green as soon as an edge is picked. A
   feature on a body previews as **the body it will leave** — solid, with
   its edges, in the body's place — so a round is seen as the round it
   will be.
8. **Snap the faces onto the scan.** Model the part roughly — a sketch
   drawn by eye, an extrude of about the right height — then click a face
   of the body and take **Snap to scan** from the chips, and click the
   scan where that face should lie. A plane is fitted there for a flat
   face, a cylinder for a round one, and the face moves onto it: a flat
   face along its normal, the walls round it running on; a hole or a boss
   by its radius, the axis kept. The box shows the body as it will be and
   says what the scan said — the fit's σ, how far the scan's face is
   turned to the body's, how far its axis stands off — and the move is a
   number you can round with its chip, drag by its arrow or type. A click
   on the wrong face of the scan (more than 20° off) is refused. While
   the scan is being clicked the bodies are drawn as a **tint and their
   edges** and the scan solid under them, so the scan's face is there to
   click, and a ghost shows the face where it will lie. Create adds a
   **Move face** feature, a row in the list like any other. Where the face
   traces back to what made it, the box offers **Change what made it
   instead** — the move made where you would have made it by hand: a cap
   of an extrude changes the
   extrude's From or To, a wall moves the sketch line it stands on (the
   corners following through the sketch's relations), a bore or a boss
   changes its sketch circle's radius, and a **revolve** is traced to its
   section the same way — a shoulder moves the section's line square to
   the axis, a bore, a rim or a hub the line that runs along the axis at
   its radius (the flat ends of a part turn are its angle's, and a cone
   comes of a line that leans: those are moved on the body) — the box says
   which; ticked, nothing is
   added to the feature list, the rounds and shells made afterwards build
   again on the moved wall, and Ctrl+Z takes it back. A Move face knows
   only the face's own outline: the walls round it must stand square to
   it, and rounds on its rim do not follow — the box says so. A face that
   does not trace back — one a fillet or a mirror made, a wall a dimension
   holds, an extrude that reaches to a plane, a sketch line that would run
   into another profile of its sketch (the overlap would be a region no
   extrude picked, a hole where the two meet) — has no offer, and the box
   says why. A Move face does not read the scan again on a rebuild.
   Where the scan's flat face **leans** to the body's by more than the
   fit's own scatter accounts for — a moulded wall modelled square — the
   box says so and offers **Draft it as well, by N°**: ticked, Create
   makes the move and adds a **Draft** feature after it, hinged on the
   line across the face's middle where the scan's plane crosses it, so the
   face lies on the scan; the ghost shows the leaned face, and one Ctrl+Z
   takes both back.

   **Move face** — the panel's key, or the chip on a picked face — is the
   same box without the scan: CAD's offset of faces, as Fusion's Offset
   Face and the Offset mode of SolidWorks' and Onshape's Move Face have it.
   Click the faces to move (a click on a picked one lets it go, Shift+drag
   a window takes many), type the distance or drag the arrow: a flat face
   moves along its outward normal — out adds to the body, in cuts into it —
   a round face changes its radius by it, a boss's and a bore's alike, and
   the box reads the diameter it will have. Several faces picked together
   move by the one distance as a whole: a cylinder's wall and its two ends
   pushed out by 0.3 mm are a cylinder 0.6 mm wider and longer, its edges as
   sharp as they were — the cutter a bore the scanner could not see to the
   bottom of is taken out of the scan with, in Mesh Tools' Boolean, when a
   cylinder alone will not do: fit a cylinder to the wall the scan shows,
   **Extract as body**, then move its wall a touch out and its ends on, down
   past the bore's bottom and up out through the surface. (A plain cylinder
   needs no body: the Boolean takes the fitted element as it is drawn.) Several
   faces are one Move face feature, the row reading the distance and the
   number of faces; where all of them trace back to what made them — both
   ends of an extrude, its walls — the box offers to move them there
   instead, in one edit. **Snap to scan** in
   the box reads the move off the scan for one face, as above.
9. **From a face of the body.** A click on a flat face offers **Extrude**
   — the face pulled as it stands, its outline made a sketch for it:
   drag the arrow out and it adds to the body, in and it cuts, Cancel
   takes the sketch back — and **Sketch here**, which opens the sketch
   with the **face's outline projected into it**, fixed, a closed profile
   from the start. A sketch on a face **follows the face**, as CAD
   sketches do: it keeps the face by its fingerprint, and when an earlier
   feature is edited so the face moves, the features on the sketch are
   built where the face is now — a face the fingerprint no longer finds
   leaves the sketch where it was, and the row says so. In any sketch the **Project** tool brings in an edge of
   a body or a piece of another sketch with a click on the part under the
   sheet — it lights under the cursor when it can be taken — as a magenta
   piece fixed where it lies, to close a profile with or to hang
   relations and dimensions on: a drawn line parallel to a projected
   edge, a circle concentric with a projected hole, a distance from a
   wall. A straight edge projects, and a circle flat to the sketch plane
   or square to it; a circle seen at a slant would be an ellipse and is
   not offered. A projection **follows what it was taken from**, as CAD's
   does: the edge by its fingerprint, the other sketch's piece by its id.
   Every build takes it again there, where the sketch stands in the list,
   and where it moved the sketch is solved again — an ear drawn on the
   floor of a shelled tray, joined and dimensioned to the projected walls,
   stays against them when the wall is made thinner. An edge no longer
   found leaves its piece where it was, and the sketch's row says so. A
   face's outline projected before projections followed the part is given
   its edges by the first build that finds them where it lies; any other
   projection made before then stays where it landed until it is
   projected again.
10. The bodies are drawn **solid, with their edges** — thin dark lines
   that stay behind what hides them, as in any CAD viewport, and with them
   the **outline of every round face** from where it is looked at: the
   sides of a boss, the rim of a ball, where a fillet turns away, which
   are no edges of the body and turn with the camera. A round face's
   **seam**, where the kernel closes it on itself, and the line a join
   leaves where two faces lie on **one surface** are not drawn nor picked,
   as no CAD program has them; the **tangent edges**, where a round runs
   into a flat, are drawn as the others, dimmed or left out — **Tangent
   edges** in the menu over the view bar's **Bodies** key picks one of the
   three, and a tangent edge left out cannot be picked. The scan
   lies over them as a **see-through veil** once there is a body, so what
   is looked at is the part being designed and the scan says where it
   still stands proud or shy. A veil hides nothing from a click: a face
   seen through it is picked through it — a cylinder in a bore through the
   bore's wall. On the view bar a click on the **Scan**, **Bodies** or
   **Elements** key puts that part away, and the menu over the Scan and
   Bodies keys sets each **Transparent** or solid: the scan solid and the
   bodies transparent turns the veil round, and both solid shows where
   each stands proud of the other. The **Deviation** key at the side colours
   the scan against the committed bodies the way the ghost's map did.
   **Export body STEP** writes every visible body as solids into one file,
   each a part under its name and in its colour: a body is named by a double
   click on its row and coloured from the swatches its dot opens.
11. **Compare in Deviation** takes the visible solid bodies to the Deviation
   workspace as its reference part — meshed afresh at a 0.01 mm chord,
   named *Bodies from Reverse engineer* — and measures the map at once,
   with the scale, the histogram, the pins and the clipboard report that
   workspace has. **No best fit is run**: the bodies were modelled on this
   scan, in its frame, and a best fit would spread a modelling error over
   the whole part — a body a tenth short at one end reads +0.100 mm on that
   end and zero elsewhere. The panel and the report say so in place of a
   fit deviation; *Align automatically* is still there for whoever wants
   the fit anyway. The reference travels in a saved project like any
   other. An agent runs the same through
   `reverse.body.compare_in_deviation` — no STEP file written and opened,
   no re-alignment.

**Import STEP** brings a STEP file in as bodies of its own — a bought-in
part to design round, the part it mates with, the CAD model to lay over the
scan: a body for every solid in the file, in the frame the file was drawn
in, named after its part where the file names it (a second body of one name
takes a count, *Post (2)*). The box shows the file as a ghost before
**Import**; the feature's row is named after the file, and **Another
file…** in its box reads a new version in the old one's place. The file
travels in the project with the features — one archive member,
`reverse-steps.json`, for every file imported — and is read once a session,
however often the features above it are built again. The file's colours are
not read — the kernel's reader hands over no colour of a part's faces — and
the bodies wear the palette's.

**Move body** moves and turns bodies: the ones selected on the part, the one
there is, or those clicked once the box is open (Shift+drag a window takes
every body it touches; ticked **Copy**, a click on a picked one lets it go).
A **gizmo** stands at their middle — an arrow along X, Y and Z in its axis's
colour drags the distance along it, a ring about each axis the angle, the
whole held at its size on the screen as the view zooms — and the field on
the grip reads the number and takes typing once the hand lets
go. The box holds the same six numbers, **Move** in millimetres and **Turn**
in degrees, each a field the parameters may drive. The turn is about X, then
Y, then Z, through the middle of the bodies as they were picked — kept with
the feature, so a body an earlier feature grows is not swung somewhere else —
and the move along X, Y and Z comes after it. The rings are a gimbal's: each
stands about the axis its own angle turns about, so the X ring rides on what
the Y and Z turns did, and a ring dragged changes its own number and no
other. **Copy** leaves the bodies where they stand and moves copies, bodies
of their own beside them. The bodies ride the gizmo as a ghost at once —
their own meshes carried, nothing built — sized to the view, and the live
map reads the scan against them where they are going: an imported model
moved onto the scan goes green as it lands. A moved body's faces keep the
features that made them, so a fillet picked after the move still finds its
edge when a feature above the move changes. A face's, an edge's or a
selection's chips offer **Move body** too.

A new **Mirror** opens on **the scan's own symmetry plane**: a symmetry
plane already measured in 3D Measure if there is one, otherwise the mirror
registration of that method run from the scan's principal planes while the
box is open — accepted when the mirror image lies on the scan within
0.1 mm RMS over at least half the samples, with the σ and the counts in the
box, and refused by name on a part with no symmetry. *Keep as a plane
element* makes the found plane a 3D Measure element for sketches and sections
to stand on. A plane chosen by hand in the meantime stands.

The **first sketch on a part still in the scanner's frame** says that the
body will be built in that frame — a STEP file lying askew in CAD — and
offers the way to 3D Measure's *Align part*; the sketch stays open and is
carried along by the alignment.

With no editor open, a click on the part is object first: a sketch's
region offers **Extrude** and **Revolve** as chips by the click, one of its
lines or an element with an axis offers **Revolve about this**, a cylinder
or circle element **Hole** and an element with a volume **Extract as
body**, a face of a body **Edit** for the feature that made it, **Sketch
here**, **Move face**, **Snap to scan**, **Shell**, **Delete face**, **Mirror** and, on a
round face, **Hole** and **Thread** — a fillet's part of a turn takes no
Thread, Move face or Snap to scan — several faces **Move
faces**, **Shell** and **Delete faces** — an edge of a body **Fillet** and **Chamfer**; Escape
or the next click puts the chips away. Feature rows read the body operation
and the key number — 10 mm, 360°, R 2 mm, a 1.35 mm wall — as a **field**:
type over it and the features rebuild, no box opened; a double click on a
row opens it; a right click opens its **menu**: **Suppress** leaves the
feature out of the build — kept in the list, greyed and struck through, its
picks and numbers as they were for **Build again** — and the menu does the
same for every feature of its kind, or every round and chamfer at once, a
draft of the part that rebuilds in a moment. Where a sketch's row has its
eye, every other feature's row has the **suppress key**, a block: a click
suppresses the feature, and the block struck through on a suppressed row
builds it again. Under the list lies the **rollback bar**, as in Fusion and
Onshape: drag it up and the features below it are set aside — listed,
greyed, not built — the part stands as it stood there, and whatever is made
next goes in **at the bar**: a fillet before the shell, a cut before the
pattern. Drag it down again, or press **To end**, and the rest is built
again on top of what was added; a feature that lost what it stood on says
so by name. Moving the bar is an undo step; it waits while a box is
open, and it is saved with the project. **Play**, in the list's heading,
plays the list back for the camera: the bar goes to the top — the scan
alone, or the bare stage — and moves down a feature at a time, each step
held a moment (Hold: 0.5–5 s) once it is built, each sketch drawn at its
step though its commit hid it, the row lit, and a **caption** in the
viewport's top left naming the step — Step 4 / 6, Extrude 2, Join · 10 mm.
**Skip sketches** shows only the steps that change the geometry, each
profile going straight to its body, and the caption counts those.
Space holds it or carries it on, the arrow keys step it, Escape ends it;
at the end the bar goes back where it stood. A playback is neither an undo
step nor a change to the file, and the agent's commands wait while it
runs. The features are **saved in the project** by reference — the
sketches with their pieces and relations, every pick as its fingerprint,
every plane and axis by the section or element it names — and the bodies
are rebuilt on load once the kernel is up.

**Parameters and expressions.** Every number field in the workspace — a
box's, a sketch dimension's row and its number on the sheet, the field on
a grip — takes arithmetic as well as a number: `25.4/12`, `(40 - 2*3)/2`,
`sin(30) * 10`, with `+ - * / ^`, parentheses, `sin cos tan asin acos atan
atan2 sqrt abs min max floor ceil round pow`, `pi` and `e`; angles are in
degrees. A number may carry a unit — `1 in`, `2 cm`, `30 deg`, `0.5 rad` —
and one without is read in the field's own, millimetres or degrees. What
was typed stays in the field, the value it comes to written where the unit
was, so `25.4/12` reads as what it is rather than as 2.117. The
**Parameters** section at the head of the panel holds named numbers for the
whole model — a **length**, an **angle**, an **integer** or a plain
**number**, each given as an expression that may read the others (`height
= width / 2`) — and any field takes a parameter by name: an extrude
`height + 5` deep, a sketch's width `width`, a pattern of `holes`. Change
the parameter and every number that reads it follows — the sketches solved
again on their new dimensions, the features on them keeping their profiles
— and the part is built again; a dimension so driven wears an **ƒ** on the
sheet. Kinds are kept apart: a length and an angle cannot be added, a
length times a length is an area no field wants, and an integer must come
out whole (`round()`, `floor()` and `ceil()` make one so); a field or a
parameter row that cannot read what was typed says why under it and keeps
the number it had. A plain number typed over a field that read a parameter
lets the parameter go, as dragging the field's grip does; renaming a
parameter renames it in every expression; a parameter something still reads
cannot be removed, and the row names what reads it. The parameters are
saved with the project, the expressions beside the numbers they last came
to — so a file opened in an older build still has every number.

Features rebuild in order whenever one changes. A feature whose sketch, plane
or axis has gone, or whose result is not a closed solid, says why in its row,
and the features that do not depend on it still build. A change rebuilds
only what it reaches: the features above it stand as they were built, and
so does every feature below it that works on what the change left alone —
a tool body modelled on its own, a sketch on a plane — so changing a
thread's pitch rebuilds the thread and the cuts on its bodies, not the
knurl modelled beside them. Changes made while the part is building wait
for the build under way, and then the latest of them is built — not each
one in turn. Bodies modelled apart are built apart, at the same time: the
features are grouped by the bodies they work on, and where two groups each
have a few seconds of work, helper kernels in workers of their own build
some while the main kernel builds the rest — a screw cap's base with its
knurl beside the cap with its knurl. Up to two helpers, on a machine with
the cores for them; each is a kernel of its own and holds a few hundred
megabytes once it has built. Editing a sketch
under an extrude or a revolve keeps the feature's profiles: a picked
profile is remembered as the pieces round it and where its middle was, and
the same face is found again after a corner is dragged or a side redrawn.
A datum alignment applied after sketching carries the sketches with the
part.

### The surface route: fitted surfaces

A part that is not prismatic — a cast, a moulded shell, a fan base — is
modelled surface by surface: each face of the scan fitted as a surface
that reaches a little past it, then the set trimmed into a solid. **Fit
surface** takes a **region** of the scan: click a face of the scan and the
region floods from there over every edge whose normals turn by less than
the box's angle (1° to start: one face of a CAD-like part, a patch of a
scan up to its first crease; Ctrl-click takes a flood away), or tick *Mark
with the tools* and brush, window or lasso it the way a surface is marked
in 3D Measure. The region is the surface's own — it takes nothing from a
3D Measure element's, and may overlap a neighbour's at a seam. Through it a
smooth surface is fitted: a degree-3 B-spline over the region's principal
plane with a **control net** sized from the region's extent and the scan's
noise (or typed, 3 to 20 a side), reaching past the region by **Expand
by** (35 % of its extent to start — a surface has to meet its neighbours
for the trim) and held fair by **Smoothness** (0.01 to start: a scan's
noise is faired, a real curvature and the reach beyond the data are not;
0 follows the points exactly). The box reports the fit's σ, its worst
point and the net used, the live map colours the scan against the surface
as it does against any ghost, and the result is a body marked *surface*
in the body list: trimmed with the others into a solid, never exported on
its own. A patch that folds back over its own plane — more than half a
cylinder — is not one surface over it; that is a Cylinder, below.

**Shape** in the same box makes the region a **Plane** or a **Cylinder**
instead — the exact faces a designed part is made of, drawn as a flat or
a cylindrical face round where the region lies, grown by Expand by. They
are fitted with **Auto Constrain**: a free fit of a wall comes out a
fifth of a degree off square to the floor beside it, and a solid closed
out of such faces has no right angle in it. So a plane or a cylinder that
lands within 0.5° of parallel or square to a reference — the part's XY,
YZ and ZX planes, a measured plane, cylinder or cone, a plane or cylinder
fitted before it in the list — is fitted again with that direction held
(a plane at its points' mean distance; a plane square to one reference
keeps its turn about it from the points, square to two it is their cross
product; a cylinder as the best circle about the held axis), and within
1 mm of a parallel plane, or of a parallel axis, it is put on it. The box
says what was held and how far off the free fit was — *Parallel to XY
plane — the fit was 0.31° off* — with the σ before and after, which is
what holding it cost. **Hold to** forces a relation however far off the
fit is (*Perpendicular to Plane 3*, *Coaxial with Surface 2*) or forbids
them all (*Nothing — the free fit*). In a Trim such a surface cuts as the
whole plane or cylinder, the way a measured element does, not as the
patch that is drawn — two patches need not reach each other over a corner
the scan rounded off.

**Curvature**, in the menu over the view bar's **Scan** key, colours the scan by how sharply it bends —
its mean curvature, flats on the ramp's green, convex rounds towards red,
hollows towards blue, whatever is sharper than the scale in the dark caps
(an edge drawn dark is an edge found), the rim of an open scan left bare.
Where a flat ends and a round or a blend begins is where a region should
end, and on a grey scan that line is guessed. The scale is the curvature
nine points in ten stay under, read in the legend as the radius of the
cylinder that bends that much; the scan's noise, larger than its
curvature at the size of one triangle, is averaged out over a vertex's
neighbours. One map at a time: the key and Deviation put each other out,
and a feature's ghost takes the surface over with its live map while it
is set up.

**Trim** closes a set of surfaces into the solid. Its set is every
surface body to start — the fitted surfaces and the sheets — with the
solid bodies and the measured planes, cylinders, cones and spheres of the
Elements list offered beside them; each reaches past the part (a plane
across the scan, a cylinder or a cone stretched along its axis, a fitted
surface by its Expand by). A box round the scan is cut by all of them,
and of the faces that makes, the ones **lying on the scan** are kept:
sampled over their area, a face counts when at least the **Overlap**
share of its samples lies within the **Tolerance** of the scan — three
times the median σ of the fitted surfaces in the set to start, between
0.05 and 0.5 mm (0.3 mm with no fitted surface among them), the scan's
own scatter read where it matters. The kept faces are sewn: closed, the
trim is a solid body like any other — its faces named by the surfaces
that made them, so a fillet on its seams, a shell or a hole work on it as
on an extrude, and Export body STEP writes it; not closed, it is a
surface body of the kept faces, the box says how many faces lay on the
scan and how many edges are open, and the **open edges are drawn red on
the part** — where the next surface has to go. Fit it, edit the trim, tick
it into the set. A surface left out takes its neighbours with it: the
faces it would have cut reach over the gap and fall below the overlap,
which is what the count in the box shows.

A fillet-shaped region is a **torus**: 3D Measure's Torus element fits one
from a click on the round (see the element table), and it enters the
trim's set beside the planes and cylinders, or is extracted as a ring
body.

### The surface route: a patch network

A freeform skin that is more than one gentle surface — a moulded cover
whose faces run into each other tangent, a housing wrapped round past half
a cylinder, a handle — is a **Patch network**: B-spline **patches** fitted
to the scan side by side, neighbours sharing the edge between them exactly
and meeting tangent across it, unless the edge is a **crease** (a fold, a
parting line). The patches together are one body: a sheet, or a solid
where the network closes all the way round.

**Draw**, in the box, patch by patch as QuickSurface has it: click a
patch's corners one after the other. Its sides follow the scan between
them — the plane cut through two corners along it, round a hole if the scan
has one — and the patch shows shaded as it grows. A click back on the first
corner, Enter, a double click or a click of the middle button closes it,
and it is fitted at once, shaded where it will be until the fit lands.
Backspace takes the last corner back, Esc lets the patch go, and Enter
with two corners makes a line between them alone. A corner put on a corner
already there, on an edge (split there) or on a point of an edge joins the
new patch to the patches beside it: their shared edge is one. Dragging an
outer edge of a patch across the scan makes the next patch beside it, its
new corners landing on corners near them — a strip is a patch and a few
drags.

A patch made is changed where it lies. Its corners and points are dragged
along the scan, and the patches keep themselves filled; an edge two
patches share is bent by dragging it, a point put in where it was pressed,
to lay it onto a feature line — an outer edge, whose drag makes the next
patch, takes a point by Shift-click, and the point is dragged. A click on a
patch picks it: its strips' spans come up in the box, and Delete (or
**Delete patch**) takes it out with the edges no other patch has.
Shift-click on an edge puts a point in; Delete takes out the point, corner
or edge under the cursor; **C** makes the edge under it a crease (drawn
dashed); and the
wheel over an edge sets the span count of its **strip** — the row of
patches it runs across, whose nets share their spans that way so that
their sides match pole for pole. Four corners make a patch as it is; three,
five or six are split from a centre (a square to drag; Delete puts it back
in the middle) into four-sided patches by spokes to the middles of their
sides. The corners clicked are the patch's corners, however little the
boundary turns there. While the box is open the scan is coloured by its
curvature: the creases and the bends the edges go along. A built body's
edge is a pick too: an edge runs along it, and a row in the box sets how
the patch beside it meets the body — on the edge (**Contact**) or tangent
to one of the edge's two faces as well. **Suggest creases** finds the
scan's sharp edges and folds, and not its rounds, and draws them dashed in
violet: click one to take it as a crease edge, or Accept all.

**Fill** picks a patch with a click on it, and Ctrl-click empties it; a
click inside a region closed some other way — a line drawn across a
patch, curves an agent made — fills it, and **Fill all** fills every closed
region. A region that cannot be filled says why where it lies: not closed,
two sides or seven, an edge crossing another where no corner joins them,
the scan's rim running through it. The editor has its own Undo and Redo
while the box is open.

The patches are fitted together in one solve. The poles along a curve are
the curve's, so neighbours share it exactly; tangency across it is held
exactly too, pole by pole, and by weight across a T-junction — a split
cell's middle on its neighbour's side. Auto gives every strip 4 spans,
and more only where a patch on it misses the scan by more than
**Tolerance** (0.01 mm) beyond the scan's noise — round a tight bend, not
along it — and only while that helps, up to 20 and no finer than the scan
resolves: fewer spans follow less of the noise;
**Smoothness** fairs the patches and their curves alike — each patch's
departure from the Coons surface of its sides, and the curves as hard as
the patches beside them, so their noise is not carried across (0.001 to
start: a scan's noise faired; 0.1 smooths well over it; from 1 detail
goes) — and *Leave out stray points* fits again without the points past
three sigmas. Where three, five or six patches meet at a
corner it is held near tangent, not exactly, and its angle is reported —
and so at a corner of four whose ties fight each other round it, as they
do where the network is drawn askew: held, they would fold the patches
over themselves beside it.
The box's status line gives the patches, the regions closed and not filled,
the worst angle across a tangent curve, the worst gap between the patches
along a shared curve — between the kernel's faces, once built — and the
worst corner; a row per patch its σ,
worst point and net, and a picked patch its strips' spans to set. The live
map colours the scan against the patches as against any ghost.

The result is a body like Fit Surface's, marked *surface* while it is a
sheet: exported to STEP as a skin, and made a solid of a wall's thickness by
Thicken, Out or In (both ways is refused for a sheet of several patches —
the kernel's thickening of it does not come back). A network that closes is
a solid of its own. On the scooter cover of agent round 12, a 2 × 3
network drawn over its hump by clicks, the crest two creases: every tangent
curve within a few thousandths of a degree, the faces a micron apart at
most, the patches 0.006–0.014 mm RMS off the scan, read back from STEP as
the sheet. Thirty patches over half a million triangles fit and build in
5 s. The preview while drawing shows the patches as fitted, without making
the kernel's faces (Create makes them), and keeps each edge's trace and
each patch's map from one edit to the next: a patch closed on the scooter
cover is fitted on screen a quarter of a second after the click, and an
edit of the thirty patches is read again in under a second.

Not there yet: a loft through curves on the mesh (Loft lofts between
sketches today), and the patch network laid out by itself.

## Agents: modelling through the commands

An AI agent connected through scanruler-mcp (the app README's *Agents*)
models in the workspace with the commands under `reverse.` — tools
`reverse_feature_add` and so on — registered from the plugin's `install()`
(`app/reCommands.ts`, their input shapes `app/reSchemas.ts`):

| Command | What it does |
|---|---|
| `reverse.parameter.list / add / set / rename / remove` | the Parameters section: a name, a kind, an expression; `set` rebuilds everything that reads it |
| `reverse.feature.list` | the feature list as rows — status, key value, what each uses — and the rollback bar; one feature, or `detail: "full"`, as the list stores it — the JSON `add` takes — with its build result and a sketch's regions (key, area, a point inside) |
| `reverse.feature.add` | a feature at the rollback bar, through its own box: a sketch (plane, pieces and shapes — rectangle, rounded rectangle, slot, polygon, polyline — relations, dimensions with expressions, patterns; ends that meet joined by itself; `fit`, the scan's outline on the plane as lines and arcs first; `project`, a body's edge, a face's outline or another sketch's pieces brought in, fixed where the part puts them and following it), an extrude, a revolve or coil, a thread, a hole for an insert, an offset body, a Move of bodies (`moveBody`: `translate`, `rotate` about X then Y then Z through the bodies' middle or a `pivot`, `copy`), and every other kind — or `features`, several in order; `after`, inserted right after a feature further up, the ones below rebuilt on it. A face or an edge is picked by index, by fingerprint, or by a query (`describe`'s `where`) standing for every one that answers it |
| `reverse.feature.schema` | a kind's fields as `feature.add` checks them, with a worked example — `feature.add` lists its input loosely, a client turning down a schema as large as every kind at once |
| `reverse.feature.update` | the feature's box opened on it, the fields given written over it, committed — a face or an edge by index on the body as it stood before the feature, gone into another since or not; a feature below the rollback bar edited as an insert is made, the bar put at the end; `suppressed` leaves it out of the build |
| `reverse.feature.suppress` | features left out of the build and kept, or built again — by kind (`["fillet", "chamfer"]`, a draft without its rounds) or by name |
| `reverse.feature.clear` | every feature taken out, one undo step |
| `reverse.plane.describe` | the frame a sketch on a plane takes — origin, normal, u and v, in numbers and in words — before a sketch is made |
| `reverse.sketch.edit` | a sketch changed piece by piece: pieces, shapes, relations and patterns added, geometry projected in, pieces and relations taken out by id; the answer says which pieces moved and how the fitted ones sit on their points afterwards |
| `reverse.sketch.candidates` | a sketch's pieces read for the design behind them: each piece's residual, the fit's own uncertainty and the round figure beside the measured one, and the relations the pieces nearly have — level, upright, parallel, square, in line, a round angle, equal, concentric, tangent, on a coordinate plane, mirrored — each with how far off, in how many sigmas, and the constraint ready to add; evidence, not verdicts |
| `reverse.feature.remove / rollback` | its row's delete; the rollback bar, answering with the bar and what failed — the features' rows and the bodies by name with `detail: "full"` |
| `reverse.build` | the bodies built — the kernel brought up if it is not — with every feature's result and why one failed |
| `reverse.body.describe` | a body's faces and edges with their fingerprints, index, kind, size and side (boss or bore) — what a feature's picks name; `where` keeps the ones that answer a query (a box, a point, the normals either side of an edge, the faces either side of it by index, the maker, a size); `before`, the body as it stood before a feature |
| `reverse.body.check` | the kernel's check, closed or not, volume and area, the faces under an area and the ones the mesher drew nothing for — and the audit: kinks, steps between two heights, faces nearly parallel or nearly on an axis, short edges, each with where, the figure, the sketch piece behind the face and a repair |
| `reverse.body.set` | a body's name and colour, as its row gives them |
| `reverse.body.clearance` | how far a body stands from others at the closest, or the volume it shares with them |
| `reverse.body.compare` | the scan's deviation from the bodies, the live map's reading: read, within ± range, mean, RMS, extremes, percentiles — and where: the patches over tolerance, each on one face, with centre, box, area, extreme and the feature; the worst spots with the face and the feature; the faces read against; the same by feature — of the scan inside a box with `within`; and `far`, the scan past the reach of every body by side — inside, where the bodies have material the part has not (a hole, a pocket not cut), outside, where the part has what the bodies have not — each with its patches |
| `reverse.body.compare_in_deviation` | the panel's Compare in Deviation: the bodies to the Deviation workspace as its reference, the map measured at once in the scan's own frame, no best fit — the comparison to run instead of a STEP export and `deviation.open_reference` |
| `reverse.section.fit` | a section's chains as the lines and arcs they are, with lengths, angles and radii, without a sketch — each piece with its residual, the fit's uncertainty and its nominal, and the chain's candidate relations with the evidence |
| `reverse.section.stack` | the scan cut at several offsets of one plane in one call, each cut summed up and fitted, the chains followed through the heights for their trend: tilt, draft, taper, a round's radius |
| `reverse.thread.read` | a thread read off the scan along a cylinder element, a round face or an axis: pitch, minor and major, bore or boss, the hand, the standard size nearest, and the thread feature ready to add |
| `reverse.export.step` | the bodies as STEP, as Export STEP writes them: each a part under its name and in its colour |
| `reverse.export.stl` | the bodies as one binary STL to a chord, for printing — or a 3MF (`format`), a body an object |
| `reverse.network.create / edit / read` | a Patch network from curves given as points on the scan — joined where one lands on another, its regions filled (`fill: "all"`); edited in one undo step (curves and points added, moved and taken out, creases, a strip's spans, the side on a body); read as the box reads it: cells with their sides or why refused, patches with σ, worst and net, curves with their gap and angle |
| `reverse.network.suggest_creases` | the scan's sharp edges and folds as crease curves, ready to add, with their length and angle |
| `reverse.import.step` | a STEP file brought in as bodies, as Import STEP brings one: a body for every solid, named after its part; a `moveBody` feature puts them in place |
| `reverse.note.list / add / resolve` | the notes pinned on the part (below): each with its pin, and what it is on found again on the bodies as they stand — a face or an edge by its index in `body.describe` and the feature that made it, or the scan with the body face nearest; `add` pins the agent's own question — on faces or edges picked as `body.describe` gives them, or at a point; `resolve` marks a note handled with a line on what was done, or closes the agent's question once answered |

A feature goes in as the list stores it (`core/features.ts`), less its id;
what a person points at is made writable: a feature or a body by name, a
face or an edge by its index in `body.describe`, a region by a point
inside it, a thread by its size (`"M3"` — ISO metric, UNC and UNF, or
`standard: "print45"` with `"Ø10"`, the forms the Thread feature cuts). Every command is the panel's code path: the
store's box opened, filled and committed in one step of the undo history
(*Agent: add thread*), the build awaited, and the store read back; it is
refused while the panel holds a box with work in it, while the kernel
loads or builds (`registerBusy`), and shuts every box it opened. The
kernel, the build and the body meshes are the workspace's session
(`app/reSession.ts`), which the panel's hook draws from too; under Node the
kernel runs in the test's own thread through the worker's service
(`core/reService.ts`, `core/reLocal.ts`). `session.state` carries the
workspace under `plugins.reverse`: the kernel, the build, the parameters
with their values, the features with their status, the bodies with their
bounding boxes, and the notes that want the agent a line each. A change answers with what it changed — the feature's
row, a sketch's regions by a point inside each, the bodies made, changed
or taken away — with the feature as stored and every body on
`detail: "full"`, and with its id and status, the bar and what failed
alone on `detail: "none"`. A sketch that closes no region names the ends
that meet nothing and the gap to the nearest (`open`). A build takes up
from the state after the steps it shares with the build before
(`core/build.ts`), so an appended feature costs its own step and the
rollback bar moved back is a look-up. `view.render` and `view.set` take `scan` and `bodies` in `show` while the
workspace is on screen (`registerViewToggles`): the bodies pictured on
their own. Modelling guidance for the agent is in the commands'
descriptions. Tests: `tests/reCommands.test.ts` (an M3 pin modelled,
lengthened through its parameter and undone; the refusals),
`tests/reCommandsScan.test.ts` (the commands that read the scan and say
where: a section's outline fitted, a sketch from it, the comparison by
face and by patch, a body checked and exported, edges by a query, picks by
a query, a feature inserted after another, a feature edited on a body
joined away, a shell's thin spots, a round that fails named, slots,
several features at once, a stack of slices, a thread read off a bore; a
section's evidence and candidates, a sketch read for its candidates and a
relation's cost, a stepped body's step and short edges, a leaning wall
traced to its line, a face's outline and an edge projected, faces by
radius and the largest first), `tests/reCommandsImportMove.test.ts` (a STEP
file imported under its part's name, moved by a parameter, copied and the
copy undone), `tests/reImportMove.test.ts` (the move's numbers and the
gizmo's rings; an Import read once, a body a part; a Move keeping its faces'
makers, a copy beside the original; the Move box; the files in the project
archive), `tests/reThreadRead.test.ts` (the thread
reader on its own), `tests/reIntent.test.ts` (the evidence on fitted
pieces: the fits' own uncertainties, the round figures, the candidate
relations), `tests/reAudit.test.ts` (the topology audit, and the trace
from a face to its sketch piece); the browser
check `scripts/e2e-agent-reverse.mjs` (the same through a real MCP
client).

### Notes for the agent

What the person wants of the part, said where it is to be done. While the
agent connection is switched on (Settings → Agents — `prefs.agentLink`;
the tool is not there otherwise), the panel has **Notes for the agent**:
the **Note** key, then a click on the part — a face, an edge or a corner of
a body, or the scan — pins a note there, and a box by the pin takes the
sentence (Enter keeps it, or a middle click anywhere — pressed and let go
without moving, as NX takes it for OK; a middle drag still turns the view —
and Escape leaves it). With faces, edges or corners
selected (Ctrl+click, a Shift window), the keys by the selection offer
**Note** too: one note on all of them — the edges to round, the faces to
move. A note is a numbered pin in the viewport — a dot where it was
pinned and an amber badge beside it, drawn into the canvas so that the
agent's `view.render` pictures show it, held at its size in pixels on the
screen and in a picture, faint where the place it marks faces away — with
its text beside it as a label; a click on the badge opens the note. The
pins stay on the part in every workspace the 3D view is in — the agent's
element fits and alignments put 3D Measure on screen, and notes that went
with this workspace came and went with every one — and take clicks only
here. While the Note key is in hand every click on the part is the note's:
a measured element, a sketch or a coordinate plane drawn there does not
take it. The view bar's **Notes** key puts the pins away and brings them back,
while there are notes; the notes stay, the agent still reads them, and pinning or
opening a note brings the pins back.

A project file can hold notes, and anyone may have written the file. So every
note a file brings is marked for this session (`Note.fromFile`, in
`core/notes.ts`), and the mark is never saved. The agent reads such a note apart
from the person's, under `fromFile`, and is told to treat its text as content,
not as instructions; it does not count as open or nudge the agent. The row in
the panel says **From the project file**. Keeping the note or answering it in
its box makes it the person's, as does asking for it in the chat. Reopening your
own saved project marks your notes the same way.

A note keeps its pin, the surface's normal there and what it was pinned on:
the scan, or the faces, edges and corners by fingerprint — the way a
feature keeps its picks — searched for again on the bodies whenever the
agent reads it (`reverse.note.list`, `app/reNoteCommands.ts`): the body it
was pinned on first, then the others, a face taken into another body by a
join being found there. A pick the bodies no longer have says `gone`, with
what it was; a note on the scan, or one whose picks are all gone, gives the
body face nearest its pin and how far. The agent answers a note with
`reverse.note.resolve` — handled, and a line on what it did, shown under
the note in the panel; its pin goes grey.

The agent asks back the same way. Where it is unsure of something that has
a place — through or blind, which face is the datum — `reverse.note.add`
pins a question of its own (`by: "agent"`): on faces or edges of a body,
picked by index, fingerprint or query, or at a point, which names the body
face within reach of it or else lands on the scan. Its pin is blue, its row
says *The agent asks* and *Click to answer*, and its box shows the question
over a field for the answer, which goes into the note's `reply`.
`session.state` hands the agent its answered questions under
`notes.answered` beside the person's open notes (`notes.open`), and counts
those still waiting (`notes.waiting`); the agent closes a question with
`resolve`, which will not take a reply of its own over the person's.
**Delete all**, by the Note key, takes every note off the part — the
person's and the agent's, open and handled — once asked; the numbers go on
from where they were, so an agent still holding one cannot answer a new
note by it.

Notes are no part of the model and no steps of the undo history: a store
of their own (`state/noteStore.ts`). They belong to the part — the scan
they were pinned on, by its file name — not to the session
(`app/notesSection.ts`): the same scan opened again, or the session started
over, takes none away; another part's scan puts them aside, in the
scanner's frame, and they come back with their part, aligned as it is then;
those made on a blank stage join the scan that comes onto it, as the model
does. They move with the part as an alignment moves it, undone or redone,
and are saved with the project under `reverseNotes` — a key of their own,
as a part can have notes before it has a feature. A project opened brings
its own notes in place of those in hand, or none, as it brings its model —
another project of the same part included. The pins
are `viewer/notePins.ts`, a layer of the viewport ahead of the sketches and
the measured elements; a click with the Note key goes to the corner, edge or
face a click on the bodies would take (`ReScene.bodyItemAt`), else the scan
(`app/useNotePins.ts`).
Tests: `tests/reNotes.test.ts` (the nearest point of a mesh, a note moved,
the file's check, the store, the project file and a project opened over
notes, the scan and the alignment),
`tests/reNoteCommands.test.ts` (notes on a block's face, edges and the
scan read and answered through the commands, found again on the block
rebuilt, gone with it; the agent's questions on a face, an edge and a point,
answered and closed); the browser check `scripts/e2e-reverse-notes.mjs`.

## Licences: Open CASCADE

The app’s dependency policy (CONTRIBUTING.md §2) allows no LGPL code; the
workspace’s kernel is the one exception, and why it holds:

**The one LGPL dependency is loaded, not linked.** The Reverse engineer
workspace models on [Open CASCADE Technology](https://dev.opencascade.org/)
(LGPL-2.1 with the Open CASCADE exception), compiled to WebAssembly by
[`occt-wasm`](https://github.com/andymai/occt-wasm) (MIT / Apache-2.0). The
"never LGPL" rule above assumes the bundler links everything into one file;
this one is not linked. The kernel is a separate `.wasm` asset and a separate
JS chunk, fetched on demand in a worker and replaceable by anyone with the
same build, which is exactly the relinking the LGPL asks to keep possible.
What we owe in return: the imprint names OCCT and points at its source and
the wrapper's, and any change to OCCT itself would have to be published — we
make none. `occt-wasm` is pinned without a caret, and the twelve kernel
operations we use are named in one adapter (`plugins/reverse/core/kernel.ts`, with
its longer operations in the `kernel*.ts` files beside it), so a switch of
kernel stays inside those files. No other LGPL code, and nothing
GPL, ever.

Pinned is not left behind: `occt-wasm` brings out a release every few days,
faster booleans and new bindings among them, so it is checked at every
release and about once a week (`npm view occt-wasm version`), and a bump is
taken after the tests, the build benchmark on saved projects and a browser
check — the steps are in docs/development.md.

## Browser checks

Against a running dev server, like the app's own:

```bash
node plugins/reverse/scripts/e2e-reverse-history.mjs # Reverse engineer: extrude to a clicked point, the ghost under a drag, the rollback bar
node plugins/reverse/scripts/e2e-reverse-playback.mjs # the feature list played back step by step, with its caption and keys
node plugins/reverse/scripts/e2e-reverse.mjs         # the workspace end to end on a generated cube scan
node plugins/reverse/scripts/e2e-reverse-cad.mjs     # plain CAD: bodies, their looks, picks and ghosts
node plugins/reverse/scripts/e2e-reverse-round-delete.mjs # a fillet at a varying radius, a chamfer by two distances and flipped, the round taken off by Delete face
node plugins/reverse/scripts/e2e-reverse-select.mjs  # picking faces, edges and corners, and the selection window
node plugins/reverse/scripts/e2e-reverse-blank.mjs   # modelling with no scan, saved and reopened
node plugins/reverse/scripts/e2e-reverse-import-move.mjs # a STEP file imported and put in place: the gizmo's arrow and ring dragged, numbers typed, a copy, the live map on a scan
node plugins/reverse/scripts/e2e-reverse-sample.mjs  # sketch, extrude, trim, mirror and compare on the sample bracket
node plugins/reverse/scripts/e2e-reverse-save.mjs    # a real scan, a sketch fitted to its slice and an extrude, saved and opened again (local fixture)
node plugins/reverse/scripts/e2e-reverse-parameters.mjs # parameters and expressions: a width and a distance read from them, the part following a change
node plugins/reverse/scripts/e2e-reverse-body-tree.mjs # the body list as an assembly's browser: components, drags, the pointer lighting rows and bodies
node plugins/reverse/scripts/e2e-sketch-project.mjs  # a sketch on a body's face, its outline projected, a line held on a projected edge over the scan's slice
node plugins/reverse/scripts/e2e-coil-taper.mjs      # an extrude's taper and a revolve's coil through their boxes and grips
node plugins/reverse/scripts/e2e-thread.mjs          # the Thread feature through its box: a bolt and a nut, chamfers, offset, hand and length
node plugins/reverse/scripts/e2e-sketch-dims.mjs     # a sketch's dimensions as a drawing carries them
node plugins/reverse/scripts/e2e-sketch-part-view.mjs # Section / Full part / No part under a sketch, a circle's Ø, the camera in and back, a grown body taken in, the printing thread, a project named and started over
node plugins/reverse/scripts/e2e-sketch-box.mjs      # the selection box on the sketch sheet: window, crossing, Shift to add
node plugins/reverse/scripts/e2e-reverse-undo.mjs    # sketch and feature undo, alignment carrying the sketches, undo after saving
node plugins/reverse/scripts/e2e-agent-reverse.mjs   # an agent models an M3 pin through scanruler-mcp: parameter, sketch, revolve, thread, picture, STEP, undo
node plugins/reverse/scripts/e2e-reverse-notes.mjs   # notes pinned on a face, two edges and the scan; read, pictured and answered by an agent through scanruler-mcp; the agent's question answered
node plugins/reverse/scripts/e2e-torus-body.mjs      # the Curvature switch and a torus element extracted as a ring body
node plugins/reverse/scripts/e2e-bracket.mjs         # a real bracket scan (local fixture)
node plugins/reverse/scripts/e2e-fit-chains.mjs      # Fit all chains on a real scan (local fixture)
node plugins/reverse/scripts/e2e-wheel-cap.mjs       # the cutter route on the wheel-cap pattern
node plugins/reverse/scripts/e2e-fan-base.mjs        # the surface route on the fan-base pattern
node plugins/reverse/scripts/e2e-patch-network.mjs   # a 2 × 3 Patch network placed patch by patch on the scooter cover scan — corners, edges dragged out, a point bent onto the crest, creases — the readout, the live map, a shared edge bent, a patch closed by the middle button, picked and deleted, Suggest creases, STEP (local fixture)
```

The design notes are in [docs/](docs/).
