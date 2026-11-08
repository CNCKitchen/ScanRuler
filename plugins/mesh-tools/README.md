<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Mesh Tools

The Mesh Tools workspace, as a plugin — see [../README.md](../README.md) for
what a plugin is. What follows is the workspace's chapter of the app's
documentation.

## Mesh Tools: cleaning up and reducing a scan

The **Mesh Tools** workspace works on the mesh itself rather than measuring
it. The panel's **Tools** row picks the tool in hand — **Escape**, or the
tool's key again, puts it away — and they are of the two kinds the
workspace has:

- **Remove islands**, **Delete marked**, **Flip normals**, **Cut**,
  **Mirror**, **Fill holes**, **Smooth**, **Densify**, **Shrink/expand**, **Boolean** and
  **Shell/hollow** edit a copy of the scan — the specks floating off it,
  what is not the part, a surface facing the wrong way, the
  base it stood on, the other hand of the part or the side it lost, the holes the scanner left, the scatter on it, the
  long triangles of an STL exported from CAD, the
  spray it was scanned under, a bore it could not see to the bottom of, the
  inside a print does not need — which every workspace measures once it is
  taken into use.
- **Reduce mesh**, **Wrap** and **Trim to scan** make something beside the
  scan: a light mesh to model over in CAD, held within a tolerance of it; one
  closed skin round the part, everything inside it dropped; and a body
  modelled to mend a broken part cut to fit its break — of the edited copy,
  when there is one. The scan stays as it is; **Apply** makes the reduced
  mesh or the wrap the edited copy.

A good order is the one the keys suggest: islands and marked surface off
first, the normals turned the right way out, then the cut and a mirror, then the holes,
smoothing, a shrink or an expansion, a boolean, the shell or a wrap, and the
reduction last.

### The parts list

With no tool in hand the panel lists what is in the viewport under
**Parts**, as Reverse engineer lists its bodies, each with an eye to show or
hide it: the scan — the edited copy, when there is one, in its place — the
reduced mesh and the piece Trim to scan cut, once they are made, and the
bodies Reverse engineer models, drawn see-through as Boolean offers them.
The scan and the reduced mesh lie on one surface and are shown one at a
time; with the piece shown, the scan is a veil over it. The **Scan** key on
the view bar is the scan's eye here too. A tool in hand shows what it works
on instead — the Scan key greyed out — and putting it away brings back what
the list shows. **Export reduced mesh** and **Export piece mesh** under the list save
either — as an STL or a 3MF, picked from the button — without taking up its tool again. What is shown is a way of looking —
not a step of the undo history, and not kept in a project.

### The edited copy

The edits are made on a copy of the scan, never on the scan every other
workspace measures. The first edit makes the copy; Mesh Tools shows it in the
scan's place, and every edit after works on it. The elements, the sections,
the deviation and thickness maps, Reverse engineer — all go on measuring the
scan as it was, and nothing is fitted again while you work. It is shaded as
the scan is, by ⚙ Settings → **Sharp edges**, and drawn again whenever that
changes: under **Always sharp**, the default, the rim of a bore a boolean
cut is drawn as a sharp edge, not streaked down the bore's wall — from 50°
or 60° if the scan's noise shows at 30°. Under Auto a scan reads as a scan,
and its copy is smooth all over.

The **Edited copy** section of the panel lists the edits made on it and its
triangles beside the scan's, and holds what to do with it:

- **Use for analysis** makes the copy the scan every workspace measures.
  Everything measured on the scan comes across: the elements are fitted again
  on it (a hand-marked surface keeps every vertex it had but the ones an edit
  took), the sections are cut again, a deviation map, a thickness map and a
  reduction on hand are measured again, and a Reverse engineer surface keeps
  its region. The edits move to the **In use for analysis** list; the next
  edit makes a new copy of the scan as it now is.
- **Discard** throws the copy and its edits away.
- **Export mesh** saves the copy as it stands, as an STL or a 3MF —
  `name-edited.stl`, or `name-edited-aligned.stl` when the part was moved — in the pose the scan
  is shown in, the alignment and the deviation best fit applied the way the
  scan's own export applies them.
- **Deviation**, a key in the view bar under the part whatever the tool,
  colours the copy by its signed distance from the scan in use, with a colour
  bar beside the viewport and the reading under the pointer — what smoothing moved and by how much, a patch standing off
  the surface. The scale runs to the 99th percentile of the distance; the
  bar says the furthest, the RMS, and how much of the copy is surface an edit
  added — a filled hole, a cut's cap — which has no scan under it to measure
  against and is grey.

Every edit, taking the copy into use and throwing it away are each one step
of the undo history: **Ctrl+Z** puts the copy, or the scan, back as it was
before the step, and **Ctrl+Y** makes it again. A saved project keeps the
copy beside the scan — as `edited.ply`, with the numbering that carries the
scan's vertices onto it — and the edits waiting on it.

### Remove islands

Scans come with islands: stray patches of the turntable, a fleck of dust,
spray floating off the part — each a piece of surface joined to nothing
else. They throw every reading of the whole part: the directions the
automatic alignment reads off it, a best fit that reaches for them, a
reduced mesh that carries them along.

1. Pick **Remove islands** and set **Smaller than** — a piece whose bounding
   box is smaller than this across is an island. It starts at a hundredth of
   the part's size. A size rather than "keep the largest", because a scan is
   often several real pieces: the two balls of a ball bar and the rod
   between them all stay.
2. The panel counts the scan's pieces and the islands among them, and says
   how large the largest island is and how small the smallest piece that
   stays, so you can see how much room the size has. The islands are marked
   on the part: tinted orange, and each in an orange ring a fixed size on
   screen, since a speck is a speck at any zoom that shows the whole part.
   The ring shows faintly through the part too, so an island behind it or
   inside it is marked as well.
3. **Remove** them. Nothing is deleted yet: the panel asks first — how many
   islands go and how many triangles — and **Delete** (or **Enter**) takes
   them off, **Keep them** (or **Esc**) leaves the scan as it is. Changing
   the size takes the question back. Once deleted, the panel lists the edit
   under **Edited copy**, and the copy's triangle count is the scan's less
   exactly the islands' triangles.

The edit is one step of the undo history: **Ctrl+Z** puts the islands back,
**Ctrl+Y** takes them off again.

Once the copy is taken into use, a saved project keeps the scan **as it now
is**, as a PLY under the name it was opened as — `ballbar.stl` stays `ballbar.stl` on screen — with the list
of edits. The PLY is written in the frame the scan was opened in, so an
alignment goes on it the same way it goes on the original; and it is
indexed, so its vertices come back in the order they were written, which is
what every surface marked on it by vertex relies on.

### Delete marked

What the scanner saw that is not the part — the clamp that held it, the
fixture it sat in, a patch of the table, a finger — is marked on the part by
hand and deleted.

1. Pick **Delete marked**, then **Window**, **Brush** or **Lasso** — the same
   marking tools a hand-marked fit and the local fine fit use. Marked surface
   turns orange. The right button rubs out, **Erase** makes the left do the
   same, and **Esc** or **Navigate** gives the camera its drags back without
   losing what is marked.
2. **Delete marked surface…** asks first, with how many points are marked;
   **Delete** (or **Enter**) takes them off the copy, **Keep it** (or
   **Esc**) leaves it as it is.

A triangle goes when all three of its corners are marked — exactly the
triangles shown in orange. The hole it leaves stays open; close it with
[Fill holes](#fill-holes) if the part should be closed there.

### Flip normals

Which side of a surface is its outside is set by the order of each
triangle's corners, and the thickness map, the alignment, Shrink / expand,
Shell and Boolean all go by it. A part that plainly encloses its volume
inside-out is turned the right way out when it is opened (the app's
`orientNormalsOutward`); an open scan, a sheet, or a mesh with patches
facing both ways is left as it was wound — and so is the copy, read back
with its winding as written. **Backfaces**, in the menu over the view bar's
Scan key, colours the inside of every triangle, so a surface facing the
wrong way shows.

1. Pick **Flip normals**. **Flip all** turns every triangle of the part
   over.
2. Or mark the surface facing the wrong way with **Window**, **Brush** or
   **Lasso** — it turns amber — and **Flip marked** (or **Enter**) turns
   over the triangles with all three corners marked, exactly those shown
   in amber. The marking goes with it, so the surface turned is in plain
   view.

Nothing moves and no vertex goes: two corners of each triangle swap
places, every vertex keeps its number, and the normals turn with the
winding when the copy is read again. A closed part flipped whole encloses
a negative volume. Each flip is one step of the undo history; Enter and
the middle click press **Flip marked** only, so a stray click never turns
the whole part over.

### Cut

The scan cut with a plane and one side taken off: the turntable or table the
part stood on, a flat bottom for a part that is to be printed, one half of a
part to model on its own.

1. Pick **Cut**, and what to **Cut across**: the **XY**, **YZ** or **XZ**
   plane, or an element with a direction — a plane's normal, the axis of a
   cylinder, cone or line, a circle's normal. After a datum alignment the
   coordinate planes are the datum's, so **Z** 0.5 is half a millimetre above
   the face the part was set on.
2. The plane starts through the middle of the part. Type where it should be
   — the coordinate for a coordinate plane, the offset along the element's
   direction for an element — and which side to **Keep**: **+** is the way
   the direction points, above the XY plane, out of a face.
3. While the tool is in hand the part is **shown cut**, the side that goes
   already taken away and the cut closed with the very cap the cut will make
   — worked out on the scan a moment after the plane settles, so it is
   closed where the cut will close and open where the scan is open across
   the plane, the stretches that stay open drawn grey. The panel says which:
   closed flat, how many holes at the cut it bridges, or how many stretches
   stay open. **Cut** (or **Enter**) makes it.

**Close flat** (on to start) closes the part with a flat face wherever the
plane goes all the way round it — a disc across a solid, a ring across a
bore, faces nested inside faces as deep as they go — so a closed part stays
closed. Where a hole in the scan's wall sits right at the cut, the rim comes
in stretches; a gap between them that is short against the whole rim — no
more than a tenth of it — is bridged straight across the plane, so the face
still closes, and the rest of the hole above the bridge is left for
[Fill holes](#fill-holes). A rim with no short way round — a scan of one
side of a part, a sheet that never closed — is left open, and the status
line counts the stretches. Off, the cut is left open all round.

The triangles are clipped at the plane: the corners on the side that stays
are kept, and a new one is made wherever an edge crosses — once per edge,
shared by both triangles on it, so the rim is joined up and the cap meets it
exactly. A corner that lies on the plane to the float's own precision is put
on it rather than a sliver's width to one side.

### Mirror

The scan reflected across a plane, in one of two ways:

- **Whole part** reflects all of it: the left-hand version of a right-hand
  bracket, or a part scanned from its mirror image.
- **Symmetric** keeps one side of the part and reflects it onto the other,
  which it replaces: a symmetric part scanned well on one side only, or
  damaged on one side.

1. Pick **Mirror**, then **Whole part** or **Symmetric**, and what to
   mirror **Across**. The plane is taken as [Cut](#cut) takes it: the
   **XY**, **YZ** (to start) or **XZ** plane, or an element with a
   direction, starting through the middle of the part. Type where it should
   be. For **Symmetric**, also pick which side to **Keep**.
2. While the tool is in hand the plane is outlined in violet. For **Whole
   part** the mirror image is drawn see-through over the part. For
   **Symmetric** the side to be replaced is cut away and the mirror image of
   the side kept is drawn in its place.
3. **Mirror** or **Make symmetric** (or **Enter**) makes it. It is one step
   of the undo history.

A reflection turns a surface inside out, so the triangles are turned over
with it and the part still faces out. **Whole part** keeps every vertex
under its own number. **Symmetric** clips the part at the plane as Cut does
and joins the mirror image to it along the cut, a point on the plane being
its own mirror image, so a closed part stays closed with no seam. Faces
lying in the plane, such as the cap of a part already cut there, are
dropped, since the two halves would put two of them back to back. A part
lying wholly on the side kept gets its mirror image beside it, joined where
it touches the plane.

Agents run it as `mesh.mirror`, with `plane`, `offset` (left out: through
the middle of the part), `mode` (`whole` or `symmetric`) and `keep`.

### Fill holes

A scanner leaves holes where it could not see: the bottom of a blind bore,
the inside of a sharp corner, a shiny spot, the pin the part stood on. A
slicer wants a closed mesh, and a hole reads as missing material on every
map.

1. Pick **Fill holes** and set **Holes up to**: a rim whose longest span is
   less than this is a hole. It starts at a twentieth of the part's size —
   10 mm for a part a hand's width across — well short of the opening a part
   scanned standing on its base leaves, which is as large as the part. The
   longest span, not a bounding box, so a round hole reads its diameter.
2. The panel counts the scan's open rims and the holes among them. The holes
   are marked on the part in orange, each in a ring as islands are; the rims
   left open — the scan's own border, a hole past the size — are drawn faint.
3. Choose the **Patch**, and **Fill** (or **Enter**) to close every hole
   marked — or **click a ring** to close that hole alone. The ring under the
   pointer is drawn larger; rings are drawn through the part, so one behind
   it is clicked the same way.

Each hole is closed after Liepa's *Filling holes in meshes* (2003):

- **Triangulate** — the rim is closed with triangles between its own
  vertices, the one of all the ways to do it that bends least: the largest
  angle between neighbouring triangles, the scan's triangles along the rim
  included, as small as it can be, and of those the smallest in area. A
  dynamic program finds it exactly for rims of up to 500 edges; a longer rim
  is laid flat across the plane it lies nearest and ear-clipped there, as
  long as it does not cross itself seen from there.
- **Refine** — the patch is given points where its triangles are much
  larger than the scan's along the rim, and its edges are flipped towards
  well-shaped triangles, until it is as dense as the surface it continues.
- **Fair** — **Curved** makes the patch continue the surface's bending
  across the hole (a least-squares bi-Laplacian reaching one ring out onto
  the scan, so the patch meets it at its slope — a patch on a ball bulges
  with the ball). **Flat** lays the tightest patch across the rim, flat
  wherever the rim is.

The scan's own vertices are not moved. A patch is a guess at what the
scanner did not see, and the deviation and thickness maps read it like any
other surface.

### Smooth

A scanner's scatter is bumps across the surface: it makes a flat face read as
orange peel, a reduction keep triangles for it, a thickness map speckle.
**Smooth** takes it out.

| Control | Unit | What it does |
| --- | --- | --- |
| **Smooth** | | **Whole part**, or **Marked region**: only the surface marked with a window, the brush or a lasso — in blue — is smoothed. Whole part to start. |
| **Smooth bumps up to** | mm | Bumps smaller than this across are smoothed out; the part's shape larger than it stays. Starts at a 125th of the part's diagonal — 2 mm a hand's width across — and never under two and a half of the mesh's edges. |
| **Move at most** | mm | No vertex moves further than this from where the scanner put it. Starts at a thousandth of the part's diagonal, well past the scatter of a good scan, to hold back only a fit that has run off. |
| **Keep sharp edges** | | Fit each side of an edge where the surface turns by more than 30° on its own, and leave the edge itself as scanned: a machined edge is detail, not noise. On to start. |

On a dense scan the bumps are many triangles across, and smoothing that works
triangle by triangle — Laplacian, Taubin's λ|μ — barely touches them. So each
point is moved onto a surface fitted to the scan around it, over a patch of
the size asked for: a quadric height field over the point's tangent plane,
least squares, the nearer scan weighing more — moving least squares. A bump
smaller than the patch has nothing in a quadric to fit it and is averaged
away (a ripple the size across is gone, one twice the size halved); a face, a
bore or a fillet larger than it is what a quadric fits, and stays where it
was — a noisy 10 mm ball comes out within a micrometre of its radius. A patch
is fitted to about a hundred of the scan's points drawn evenly from it,
however dense the scan, twice over — a 1.4 million triangle scan smooths in
about six seconds. Each point moves along its normal only.

With **Keep sharp edges** a point's patch takes only the scan facing within
30° of it, so a face is smoothed right up to an edge from its own side alone;
the strip along the edge itself, where the scan turns from one face to the
other on both sides of the point, is left as it was. Scan that faces away —
the far side of a thin wall — is never part of a patch. The status line says
how far the surface moved — at most and RMS — and how many points were left.

A **marked region** is smoothed alone: a face that came out rough, leaving
a textured one or a fine detail beside it as it is. Only the marked points
move, and each by less the nearer it is to the edge of the region — nothing
at the edge, all of its move the size in from it, a smooth step between —
so the smoothed patch runs into the scan around it without a seam. The fits
still read the scan on both sides of the edge. **Escape** gives the camera
its drags back without losing the marking; once smoothed, the marking goes,
so the smoothed surface — and its **Deviation** — is in plain view.

### Densify

An STL exported from CAD is cut into as few triangles as hold its shape: a
flat face is a fan of long, thin triangles from its edges, and a hole's wall
a ring of slivers from rim to rim. Its vertices lie only on its edges and
rims, none inside its faces, so a fit, a segmentation or a section that
looks for points on a face finds none, and the noise read off small patches
is the bend between facets — 1.6 mm on a bracket whose faces are exact.
**Densify** cuts the triangles until no edge is longer than a length set.

| Control | Unit | What it does |
| --- | --- | --- |
| **Longest edge** | mm | No edge is left longer than this. Starts at a hundredth of the part's diagonal, on a round number — 0.5 mm on a part 75 mm across; halving it makes about four times the triangles. |

Every edge longer than the length gets one vertex in its middle, shared by
the two triangles on it, and each triangle is cut in two, three or four by
how many of its edges were; the passes go on until none is too long. A new
vertex lies on the facet it was cut from, so the surface is exactly where it
was — a hole's wall still the facets CAD exported, not the circle — and the
mesh stays as closed as it was: the cuts on the two sides of an edge meet.
Over twenty million triangles it stops and asks for a longer edge. In 3D
Measure's checks, `scan.qa` says when a mesh is such an export and too sparse
(`tessellation`), with the length to densify it to.

### Shrink / expand

The surface moved along its normal by a distance: out to **expand**, in to
**shrink**. It is not a scale — a 20 mm ball expanded by 0.5 mm is 21 mm
across, and a bore in the part comes out a millimetre narrower, where a
scale would widen it. It is for corrections small against the part's
features: the thickness a scanning spray laid on, a clearance on a mating
face, a print that came out a little fat.

| Control | Unit | What it does |
| --- | --- | --- |
| **Move** | | **Whole part**, or **Marked region**: only the surface marked with a window, the brush or a lasso — in violet — moves, as a step. Whole part to start. |
| **Direction** | | **Expand** — out along the normal, the part grows — or **Shrink**. |
| **Distance** | mm | How far. Starts at 0.1 mm. |

Each point moves so that every face around it ends the distance from where
it was — even thickness, as a CAD offset has it. On a face that is the
distance along the normal; on a sharp edge the point goes further, square to
neither face, so both faces end the distance out and the edge stays sharp
(√2 times the distance at a right angle, √3 at a box's corner). The move is
the least-squares answer to "each face around the point, the distance along
its own normal", weighted by the angle each face has at the point and taken
only in the directions the faces spread over: the scan's scatter and the
gentle turn of a curved surface are one direction, a turn past 30° — the
angle Smooth and Sharp edges take — an edge. A knife edge would send its
point off without end; no point moves more than three times the distance.

The faces' normals are read over about as far as the surface moves first —
averaged over their neighbours, edges past 30° never crossed, as many rounds
as the square of the triangles' widths the move goes, up to 64 — since a
scan's scatter tilts its triangles by a few degrees, and a point moved
2 mm along a normal tilted 3° lands a tenth of a millimetre beside where its
neighbours do. A face turned from every one of its neighbours is a spike of
scatter, not an edge, and takes their mean. A sliver — thinner than a
fiftieth of its longest edge — has no say in a move: its normal is the
rounding's, and its all-but-straight corner would give it the most weight.
Nor has a face turned against the rest round a point: a fold, which would
cancel the faces either side of it and leave the point behind.

A move can still fold the surface over itself, and it is mended in four
steps, the same search the deviation maps use built only when one needs it:

1. **Spikes.** A point that ends nearer the surface as it was than the
   distance — by more than a quarter of the mesh's edge, the scatter's
   reach — because a point beside it stood proud, is taken out to the
   distance, and so are its neighbours in turn until none is nearer: a
   spike of the scan is not copied into the moved surface as a pit.
2. **Strips beside an edge.** Beside an edge the move turns into — a convex
   edge shrunk, a concave one expanded — the face comes out narrower by
   the distance, and when its triangles are narrower than that a strip of
   them has nowhere to go: wherever a triangle comes out turned over, its
   points are taken back out to the distance, which lands them on the moved
   edge, row by row.
3. **Closing up.** A triangle still turned over, or worn to a sliver, with
   every corner on the moved surface, is closed up: its shortest edge
   collapsed, the two points made one — halfway between, or where either
   was — as long as the mesh round it stays a surface and fewer triangles
   there are turned over after. A sliver's points are merged only across
   the strip, where the move brought them together, never along the edge,
   which would leave the face beside it a fan of long slivers. The strip
   closes into the edge and the edge is sharp.
4. **Easing.** The points of a triangle still turned over — against its
   own normal before the move, or against those across its edges now —
   take their neighbours' mean place and are put back at the distance,
   until none is.

The status line counts the points merged and eased. A slot narrower than
twice the distance closes over itself when the part is expanded, as a rib
thinner than it does when it is shrunk; neither is undone.

A **marked region** moves as a step, like a face pushed. Its rim is one of
two things:

- Where the face beside it runs along the move — the region marked up to a
  machined edge, the side face square to the one marked — the rim moves
  with the region and slides along that face, which is stretched (expand) or
  shortened (shrink) with it, evenly over a band beside the rim so no
  triangle of it turns over. The edge stays sharp, and no triangle is added.
- Elsewhere — a rim in the middle of a face — the region is split from the
  surface there: the rim stays with the surface around it, a copy of it
  moves with the region, and a wall of new triangles along the move joins
  the two. A patch pushed out 0.2 mm is a 0.2 mm ledge.

Every point the scan had keeps its number, so **Deviation** shows the
distance across what moved; the copy of a split rim and its wall are new,
and grey. The edit is one step of the undo history.

On a 1.3-million-triangle scan the whole part moves in about a second; a
sheet thickened 2 mm takes two and a half.

### Boolean

The scan and a solid made one: the solid **subtracted** from the scan,
**added** to it, or the two cut down to what they share (**Intersect**). The
solids are the **cylinders, cones and spheres** shown in 3D Measure — each as
it is drawn there, at its **Assumed Ø** where it was given one and out as far
as it was extended, with no body to make of it first — and the closed bodies
modelled in the Reverse engineer workspace, all in the scan's frame and
meshed to 0.01 mm. A hidden element is not on offer: one taken out as a body
in Reverse engineer is hidden there, and offered as that body. **Several**
solids go as one — their union — in one edit: every bore of a flange taken
out at once, bodies and fitted cylinders together, or the part trimmed to
what either of two boxes holds.

The case it was made for is a bore the scanner could not see to the bottom
of, which the scanning software closed part way down with a patch: the scan
shows the top of the bore and a floor where there is none.

1. In 3D Measure, fit a **cylinder** to the wall the scan does show, and
   **Extend** it: its far end on past where the bore really ends, its near
   end so it stands out of the surface. Give it the bore's design diameter
   as its **Assumed Ø** if that is what the bore is to come out at.
2. In Mesh Tools, pick **Boolean** and **Subtract**, click the cylinder on
   the part — and any other bore's, for them all in one edit — and
   **Perform operation**. The bore is cut clean to its floor, the patch the
   scanning software laid across it gone with it, and the tool is put away.

A cutter that needs more than a cylinder — a counterbore, a bore with a
chamfer — is modelled in Reverse engineer: **Extract as body** the cylinder,
shape it with **Move face** and the rest, and it is on offer here as that
body.

While the tool is in hand every solid on offer is drawn on the part,
see-through, and faintly through the scan as well, so the whole length of a
cylinder pushed down a bore is in view; a click on one puts it in hand, and
a click on it again takes it out (the boxes in the panel's list do the
same). A lone solid is in hand from the start. Those in hand wear the colour
of what will happen to them — red taken out, green added, blue kept — one
under the cursor that colour a shade lighter, and the rest a plain slate.
The panel says whether the mesh is closed: a boolean needs every edge to
have exactly two triangles, so a scan with holes has them closed with
**Fill holes** first. A solid that never meets the surface is refused by
name — wholly outside it, there is nothing to take away; wholly inside it,
taking it away would seal a hollow inside the part rather than open a hole;
added wholly inside it, there is nothing to add. Solids in hand that overlap
are one piece of the union and are named together.

The boolean is [Manifold](https://github.com/elalish/manifold)'s
(Apache-2.0), exact on closed meshes and quick on a scan: a 1.3-million-
triangle mesh takes about three seconds. The scan's own vertices are not
moved; those inside the solid go, and the surface the solid brings — a
bore's wall and floor — is new, with nothing of the scan under it, and grey
in the **Deviation** view. The edit is one step of the undo history.

### Shell / hollow

What the tool does depends on the mesh, and the panel says which before
anything is done:

- A **closed** part is **hollowed**: its outside stays as scanned, every
  vertex where it was, and an inner wall the thickness in from it all round
  seals a cavity — what a resin print is hollowed with.
- An **open** surface — one side of a part, a sheet — is **thickened** into a
  solid: a second skin the thickness from it, **Inward** (the scanned
  surface stays the outside, which it is to start), **Outward**, or half to
  **Both sides**, and a wall round every rim joining the two.
- A part **closed but for a few holes**, every one smaller than Fill holes'
  size, is asked to have them filled first, so that it can be hollowed —
  **Fill holes first** takes the tool there. **Thicken as it is** is still
  on offer, and comes out with a wall round every hole.

| Control | Unit | What it does |
| --- | --- | --- |
| **Wall** / **Thickness** | mm | The wall a hollow leaves, or the thickness a surface is given. Starts at a 125th of the part's diagonal — 2 mm for a part a hand's width across. |
| **Inward** / **Outward** / **Both sides** | | For a surface: which way the wall grows from it. |

#### How it hollows

The inner wall is not the scan moved in. Moved point by point, a surface
folds through itself wherever the part is thinner than twice the wall or
curves tighter than it, and a scan does both somewhere. It is the surface
the thickness in from the part's own, read off the part's distance field:
where the part is thinner than twice the wall there is nothing that far in,
and the part simply stays solid there; a boss on a thick base keeps a small
cavity of its own, or none. The wall never comes nearer the outside than the
thickness, so the two never cross, and it is closed by how it is made.

The field is read on a grid a third of the thickness across — coarser on a
part too large for twelve million grid points — in four steps:

1. **Inside.** Every column of grid points along Z crosses the surface where
   it enters the part (through a triangle facing down) and leaves it (facing
   up); a point is inside where more have been entered than left below it.
   The grid is set off the part's corner by a different odd fraction of a
   cell on each axis, so no column runs along an edge of a mesh drawn on
   round numbers.
2. **Roughly how far in.** A distance transform (Felzenszwalb & Huttenlocher)
   from every grid point outside and every one next to the surface — taken
   from points spread over each triangle half a cell apart, so a crack
   narrower than a cell still counts as surface.
3. **Exactly how far**, in a band round where the wall will be: the distance
   to the nearest triangle, from the same search the deviation maps use.
4. **The wall**, where the distance crosses the thickness: marching
   tetrahedra on the grid's cubes, each cut into the six of Kuhn's
   triangulation so neighbouring cubes cut their shared face alike and the
   wall closes. It faces into the cavity.

Cavities smaller than eight grid cells — a thick spot only just past twice
the wall — are left solid, and the wall is reduced with meshoptimizer to
within a sixteenth of a cell of where the grid put it: an order of magnitude
lighter, its volume within a few parts in a thousand. A ball 100 mm across
hollowed with a 2 mm wall comes out within 0.2 % of the cavity's true
volume, in about five seconds on a 1.3-million-triangle scan.

The cavity is sealed. To let a resin print drain, or to see the wall,
take a cylinder out through it with **Boolean**; **Cut**, while it is in
hand, shows the part cut open without cutting it. The inner wall has no scan
under it and is grey in the **Deviation** view. The edit is one step of the
undo history.

### Wrap

One closed skin round a part that is a mess inside: an assembly exported as
one file, a casting with channels and bosses inside it, shells that overlap
or face the wrong way, a scan with cracks. Everything inside goes, and what
is left is easy to print or slice.

1. Pick **Wrap** and set **Close gaps under**: every opening narrower than
   this — a slot, a hole, a crack, the seam between two parts — is bridged.
   It starts at a two-hundredth of the part's size, 1 mm for a part a
   hand's width across.
2. **Wrap** (or **Enter**). The steps it is at show under the button, and
   **Cancel** (or **Escape**) stops it, the mesh untouched.
3. Look at it: the **Wrap** key in the view bar shows the wrap, amber
   wherever it bridges an opening rather than lying on the part; **Inside**
   shows it see-through over the part, so what goes with it can be seen;
   **Scan** the part alone. The panel gives its shells and triangles, how
   many of the part's triangles lie inside it and go, the area it bridges,
   and the volume before and after.
4. **Apply** makes it the edited copy, one step of the undo history.
   **Discard** puts it away; until it is applied, nothing has changed.

| Control | Unit | What it does |
| --- | --- | --- |
| **Close gaps under** | mm | Openings narrower than this are bridged, wider ones the wrap follows down. Keep it small: a groove narrower than it is closed over too. |
| **Grow by** | mm | How far the wrap stands off the part all round. 0, to start, lays it on the part. An open sheet has no inside and wraps to nothing at 0: grow it by half the thickness it should have, and it comes out a solid that thick. At most the gap. |
| **Edges** | | **Sharp** rebuilds the part's sharp edges and corners on the wrap, for a machined or moulded part; **Smooth** leaves them rounded by the grid's cell, a sixth of the gap, for an organic shape or a scan. A wrap grown has round edges either way. |

#### How it wraps

Think of a ball as wide as the gap rolled all over the part from outside,
everywhere it can reach without touching it: the wrap is where it stopped.
Only the distance to the part's triangles is ever used — never which way
they face, nor whether they close — so any mesh is input enough: free space
is every point further than half the gap from the part, the outside is the
free space joined to infinity, and the wrap is the surface half the gap in
from the outside. Where the ball touched the part the wrap lies on it; across
every opening it could not pass the wrap spans it, rounded as the ball was.
A part with real walls keeps them however thin: the ball rolls round the
outside of a wall, not through it. Parts that do not come within the gap of
each other get a shell each.

It is worked out on a grid a sixth of the gap across — the grid only has to
see the gap — and then every vertex of the wrap where the ball touched is
moved onto the nearest of the part's triangles that lies along it, so the
wrap lies on the part as exactly as the part is meshed, whatever the grid.
Grown, it is moved onto the part grown instead: a face's plane moved out, an
edge's round. The vertices left where the grid put them are the bridges.

That leaves every edge of the part cut off by a cell, as a chamfer: where the
wrap goes round one, its vertices lie on one face or the other. **Sharp**
splits each triangle edge running from one face to another at an angle
where the two faces meet, and gives a triangle touching three faces their
corner, so the wrap of a box is the box, twelve triangles. Each point put
back has to lie on the part: where two facets of a round, or of a scan's
curved surface, meet at an angle, the point where their planes cross is off
the part, and the round stays round. Inside corners are not the part's —
the ball rounds them, by design.

The grid is cut into tiles of 64 points a side. The outside is followed in
from the grid's edge tile by tile, and only the tiles it reaches are
measured — a part's inside, however much of it there is, costs no more than
sorting its triangles — and in those only the band round the surface. The
tiles are shared out among workers, one for each core the computer has to
spare (at most eight), and the wrap is reduced on them as well, a tile at a
time and then on larger tiles shifted against the first, to within a
sixteenth of a cell.

Wrap again with another **Grow by** and the gap unchanged starts from what
was measured the time before, so it takes about half as long; a new gap, or
an edit to the mesh, measures again. On a large part a fine gap would take
too many grid points: the grid is made coarser to fit, and the panel says
so, with the smallest gap closed as exactly at that size. A mesh that wraps
to almost nothing is open, and an opening wider than the gap let the ball
behind its surface; the panel says that too. The wrap runs in a worker of its
own, so a large one leaves the rest of the app free, and the wrap on hand is
not saved with a project: a click makes it again. Once applied, none of the
part's vertices is kept, so the **Deviation** view has nothing of the scan to
measure and is grey.

### Trim to scan: a piece to mend a broken part

A part with a piece broken off — a chip off a mug's rim, a handle, a tab off
a housing: scan what is left, model the missing piece in the Reverse engineer
workspace, and cut it here with the scanned fracture, to print and glue in.
The piece's outside is plain CAD; the fracture it has to meet is far too
rough to model, and need not be.

1. In Reverse engineer, model the missing piece as a body — to the part's
   nominal shape, and a few millimetres too long at the break, so it reaches
   into the material that is still there. It need not match the part
   exactly; a little larger is fine.
2. In Mesh Tools, pick **Trim to scan** and click the body on the part. The
   **break** is found and marked on the part in teal: the scan where it lies
   deeper inside the body than the **Depth** (0.3 mm, under **Advanced**).
   The fracture lies millimetres deep in the body; the part's own skins only
   dip into a body modelled a little larger than the part, by the scanner's
   scatter and the difference between the two. Put the marking right with
   the window, brush, lasso and eraser if it caught anything but the
   fracture — or mark the break by hand. **Find again** marks it as found.
3. Set the **Offset from break** — 0 cuts the piece on the break, a tenth or
   two of a millimetre leaves room for glue — and **Trim**. The piece is
   shown over the scan ghosted, its mating face in teal, and **Export mesh**
   saves it, as an STL or a 3MF, where the part now stands.

#### How it cuts

The break is carried on along the fracture at its edges until it is clear
of the body, made a sheet the offset thick to each side — Manifold cuts only
with closed solids, as in Boolean — and the body is cut with it. The side the
missing piece is on is kept, the side the scan's surface faces; **Keep the
other side** turns that round. The body's own faces are never cut by
anything but the break, so where the model and the part differ a little, a
small step at the joint is all it shows. It is not the scan taken out of the
body: wherever the model is larger than the part by more than the offset,
that would leave a skin of the body wrapped round the outside of the part, a
few hundredths thick — flaps no print can hold. A hole in the break, a spot
the scanner missed, is closed before the break is carried on.

#### Reading the result

The panel gives the piece's volume, the area of its mating face, and how far
that face is from the part where it lies over the break: at the median, and
the range 90 % of it lies in. It is the offset as near as the scan allows —
a hundredth at an offset of 0, the thinnest the cut can be; further off in a
groove narrower than twice the offset, which the face bridges, and along the
edges of the joint, where the break was carried past the part. **Gap** in
the view bar colours the mating face by it, **Piece** shows the piece plain,
and **Break** the scan with the marking and the bodies again.

When the body misses the scan, when the break does not cut the body through
— the scan has a gap across it, or the marking stops short of the body's
edges — or when nothing of the body would be left on the missing piece's
side, the panel says so. The piece stays in view when the tool is put
away, a row of the parts list to hide, show beside the body it was cut of,
or export. The settings are steps of the undo history and are kept in a
saved project; the piece is not saved, a click makes it again. A break of a
few square centimetres takes a second or two.

### Reduce mesh: a light mesh for CAD

A scan is millions of triangles, and CAD chokes on it: Fusion warns above
about 10,000 facets when a mesh is converted to BRep, SOLIDWORKS turns every
facet into a face when it imports a mesh as a solid, and every system slows
to a crawl long before either. **Reduce mesh** makes a light mesh to model
over instead — held within a tolerance of the scan, measured to prove it,
and exported in the pose you aligned the part to.

1. **Align the part first** if it should land in CAD on its datums (3-2-1 in
   3D Measure, or the best fit in Deviation): the reduced mesh is made from
   the scan where it stands and exported there, so the part arrives in CAD
   levelled and zeroed rather than wherever the scanner left it. Take the
   loose pieces off first, too, or they come along as islands.
2. Pick **Reduce mesh**, set the **tolerance** and the **triangle limit**,
   and press **Reduce** (`Enter` or a middle click does the same).
3. Read the result — the triangle count, and how far the reduced mesh
   strays from the scan — and look at it: the **Reduced**, **Accuracy** and
   **Scan** keys in the view bar show the reduced mesh with every triangle
   edge drawn, the scan coloured by its distance from the reduced mesh, or
   the scan alone. A turn begun on the reduced mesh pivots on it, as it does
   on the scan.
4. **Export mesh**, then STL or 3MF. The file is `name-reduced.stl` or
   `.3mf` (`name-reduced-aligned` when the part was moved), in millimetres.
5. Or **Apply** it, to go on working with it here. Until then the result is a
   preview and the mesh it was made of is untouched: **Reduce again** starts
   over from that mesh, so a result that came out too coarse costs nothing, and
   **Discard** puts it away. Apply makes it the edited copy, one step of the
   undo history, listed under Edited copy like any other edit, from where
   **Use for analysis** takes it into every workspace. Once in use, the
   elements are fitted again on the vertices the reduction left, and those are
   few on a flat face. Judge the result by **Accuracy** before you apply it: the
   copy's **Deviation** reads only at the copy's own points, which lie on the
   surface, so it shows less than the triangles between them stray.

#### How it reduces

Edge collapse on quadric error metrics (Garland & Heckbert), done by
[meshoptimizer](https://github.com/zeux/meshoptimizer)'s simplifier: every
vertex carries the planes of the faces around it, the edge whose collapse
strays least from them goes first, and collapsing stops where the next one
would stray too far. That is what makes it adaptive — a flat face ends as a
couple of large triangles, a fillet keeps the density it needs. The vertex
a collapse leaves is moved to where the planes put it rather than kept on
one of the two scan points: the same count, and about a quarter less
deviation, because the best fit of a patch averages the scatter each scan
point carries.

The simplifier's own error is an estimate, not a distance anyone measured,
and across a strip of thin triangles — a fillet in a CAD tessellation, a
crease in a scan — a collapse can move the surface several times what it
reports. So **the tolerance is measured, not trusted**. Each result is
measured both ways: every scan point to the reduced mesh (detail lost), and
the reduced mesh's vertices and triangle centres back to the scan (a patch
standing proud of a surface that is not there). Wherever either strays past
the tolerance, the scan points there are **pinned** — the simplifier may not
collapse them — and the scan is reduced again, until the tolerance holds.
The pins gather only where the tolerance is at risk, so the mesh stays dense
there and nowhere else; tightening the error target for the whole part
instead costs two to three times the triangles for the same result.

**Holding the tolerance means 99.9 % of each side lies within it**, not all
of it. A scan's worst point is a spike or a speck the reduction is right to
flatten, and pinning every last one would keep the noise in the model. The
furthest point is measured and shown beside it, and the Deviation view says
where it is.

On the reference scans: a 215,000-triangle ball bar reduces to about 4,600
triangles within ±0.05 mm in half a second; a 1.4-million-triangle block to
about 20,500 within ±0.1 mm in five seconds, or 55,500 within ±0.05 mm in ten.

#### The settings

| Control | Unit | What it does |
| --- | --- | --- |
| **Tolerance** | mm | How far the reduced mesh may stray from the scan, either side of it. Starts at about a four-thousandth of the part's size on the 1-2-5 steps — 0.05 mm for a part a hand's width across. Below the scan's own scatter a tighter one buys little: the reduction has to keep the noise, and keeps nearly every triangle to do it. |
| **Triangle limit** | triangles | What the CAD system on the other end takes — Fusion warns above about 10,000 facets on mesh to BRep, SOLIDWORKS imports up to 500,000 as a solid body. Starts at 50,000. The tolerance comes first; only when holding it needs more triangles than the limit is the mesh reduced further, to the limit — and the result then says how far it strays instead. |

Both shape the reduction, so changing them means reducing again; until you
do, the panel says the result on screen was made with other settings, and
the export writes the mesh on screen. They are saved with the project,
undone and redone with everything else, and a project saved with a
reduction on hand reduces again when it is opened.

#### Reading the result

The readout gives the triangle count against the scan's, the share of the
scan within the tolerance, the distance 99.9 % of the scan lies within, the
furthest scan point, the reduced mesh's own 99.9 % distance back to the
scan, and the RMS.

The **Accuracy** view paints the scan with its signed distance to the
reduced mesh. The ends of the scale are the tolerance, so everything within
it is on the ramp and everything past it wears a dark cap — where the
reduction strays too far is the one thing on the part that is not bright.
Positive (red) is a scan point outside the reduced mesh, which is the mesh
cutting into the part there: a flat facet across a convex round reads
slightly positive all over, which is what a chord does. Hover the part for
the reading under the cursor.

## Agents: cleaning a scan up through the commands

An AI agent connected through scanruler-mcp (the app README's *Agents*)
works in the workspace with the commands under `mesh.` — the workspace's
id; the plugin's has a hyphen, which a command's name does not take —
tools `mesh_cut` and so on, registered from the plugin's `install()`
(`app/meshCommands.ts`):

| Command | What it does |
|---|---|
| `mesh.parts` | the parts list: the scan and its edits in use, the edited copy and the edits waiting on it, the reduced mesh and the piece with their figures, the solids on offer by key and name, what is shown |
| `mesh.show` | the parts list's eyes, and the copy's Deviation key — the tool put away; not a step of the history |
| `mesh.inspect` | the mesh the tools work on in figures — triangles, bounds, open edges, the volume it encloses — and its islands and holes at a size, the middle of each; with `deviation`, the copy measured against the scan in use |
| `mesh.cut_preview` | what a cut at a plane would close, bridge and leave open |
| `mesh.mark` | a region marked on the part as the window, brush and lasso mark it, for Delete marked, Flip normals, Smooth or Shrink / expand — to look at before the edit, or for the person to put right |
| `mesh.remove_islands`, `mesh.delete_marked`, `mesh.flip_normals`, `mesh.cut`, `mesh.fill_holes`, `mesh.smooth`, `mesh.densify`, `mesh.offset`, `mesh.boolean`, `mesh.shell` | the edits, each one step of the undo history — Flip normals turns the whole mesh over, or a region; Densify cuts the triangles down to `maxEdge`; Shell hollows a closed part or thickens an open one, as the panel's does |
| `mesh.reduce`, `mesh.trim` | the reduced mesh and Trim to scan's piece, made beside the scan |
| `mesh.apply_reduced` | the reduced mesh made the edited copy, one step of the undo history |
| `mesh.wrap` | the wrap, made beside the scan — `gap`, and `grow`, `edges`, `tolerance` (how far its reduction may stray) — answering with its shells, triangles, what went inside it, the area bridged, the volume before and after and the time each step took; `preview: false` applies it at once |
| `mesh.apply_wrap` | the wrap made the edited copy, one step of the undo history |
| `mesh.use_edited`, `mesh.discard_edited` | the Edited copy section's two buttons |
| `mesh.export` | the edited copy, the reduced mesh or the piece as STL or 3MF (`format`), as the panel's buttons write them |

Surface the panel marks by hand is named as a **region**: `"marked"` —
what is marked on the part, by the person or by `mesh.mark` — or a box, a
ball or a list of vertices, narrowed by the direction it faces
(`{ box: …, facing: [0, 0, 1] }` is the top face of a part standing on
the XY plane; `core/select.ts`, the worker's `select`). A cut is taken
across `"XY"`, `"YZ"`, `"ZX"` or an element with a direction, at an
offset and with a side kept that the command must name — no plane through
the middle of the part, which is what the panel starts with. A solid is
named by its key or its name, a fill by the point nearest the hole.

Every command is the panel's code path: the tool put in hand, the settings
given set through the store as its fields set them (those left out stand
as the panel has them), and the session's verb run inside one step of the
undo history (*Agent: cut at XY plane, Z 5 mm*), awaited, with what it did
and the mesh after it — triangles, bounds, closed or not, the volume —
handed back. An edit is refused where the panel's button is (anything open
in another panel the scan cannot change under), while an edit, a reduction
or a trim runs (`registerBusy`), and when the mesh is not what it needs: a
boolean or a hollow on an open mesh, a hollow on a part closed but for
holes the size of Fill holes'. One that fails puts the settings back and
leaves no step. The verbs are the workspace's session
(`app/meshToolsSession.ts`), which the panel's hook draws from too, and
which stands without a viewport under the tests. `session.state` carries
the workspace under `plugins.mesh`: the tool in hand, the parts, the edits,
every tool's settings. Tests: `tests/meshCommands.test.ts` (a cube cleaned
up, cut, expanded and hollowed, every step undone, the copy taken into use;
a body trimmed to a block, a peg taken out of it, the block reduced; the
refusals); the browser check `scripts/e2e-agent-mesh.mjs` (a cleanup
through a real MCP client: the marking looked at in a picture, the edits in
the panel, the reduced mesh as STL).

## Browser checks

Against a running dev server, like the app's own; `e2e-mesh-edits`,
`e2e-mesh-trim` and `e2e-agent-mesh` also run in the app's `npm run e2e:ci`,
listed in [ci.json](ci.json).

```bash
node plugins/mesh-tools/scripts/e2e-mesh.mjs       # Mesh Tools: reduce, remove islands, use for analysis, undo, save and reopen with a copy
node plugins/mesh-tools/scripts/e2e-mesh-edits.mjs # Mesh Tools: fill holes, smooth, cut, delete marked, deviation, use, undo them all
node plugins/mesh-tools/scripts/e2e-mesh-boolean.mjs # Mesh Tools: a cylinder modelled in Reverse engineer taken out of a closed scan, exported
node plugins/mesh-tools/scripts/e2e-mesh-shell.mjs # Mesh Tools: shrink, expand a marked face, hollow, thicken a cut-open copy, undo
node plugins/mesh-tools/scripts/e2e-mesh-flip.mjs  # Mesh Tools: flip a closed box inside-out and back, then a window-marked patch alone
node plugins/mesh-tools/scripts/e2e-mesh-trim.mjs  # Mesh Tools: a box modelled in Reverse engineer trimmed to a block's rough top
node plugins/mesh-tools/scripts/e2e-agent-mesh.mjs # Mesh Tools through an MCP client: a cube cleaned up, cut and reduced; needs npm --prefix mcp ci
```

`e2e-mesh-edits.mjs` builds its own scan too: a noisy box standing on the XY
plane with two 3 mm holes in its top. It fills one by clicking its ring and
the other with the button and checks the copy is closed after while the scan
in use is not touched, smooths it no further than the limit, checks the part
is shown cut while Cut is in hand and that the panel says it will close flat,
then cuts it at Z 5 — closed flat, so it is still closed — and deletes a
window-marked patch. It colours the copy by its deviation from the scan, checks
3D Measure still measures the scan as opened, takes the copy into use, and
steps back through all of it to the scan as it was opened. Last, with one hole open again, it
reads the cut preview across each hole: bridged under the open one, closed as
it is across the filled one.

`e2e-mesh-shell.mjs` builds a closed noisy box 30 × 30 × 20. It shrinks it
by 0.2 mm, every triangle kept, and reads off the **Deviation** legend that
the copy is 0.2 mm inside the scan all over though the corners moved
0.35 mm — a shrink, not a scale; expands a window-marked patch 0.5 mm as a
step and checks the part is still closed; hollows it with a 2 mm wall and
checks the cavity is the box 2 mm in all round, and that a cut across the
middle would close flat on a ring; steps the hollow back, deletes a small
patch and checks Shell asks for the hole to be filled first; cuts the part
open with the cap off, thickens it 1 mm inward into a closed solid; and steps
back through all of it to the scan as it was opened.

`e2e-mesh-trim.mjs` builds a closed block 30 × 30 × 20 whose top is a rough
fracture, and models a box in Reverse engineer standing 2 mm into it and
0.2 mm wider than it all round. In Trim to scan it clicks the box on the
part, checks the break is found and marked — its area the fracture's own, a
tenth in from the block's edges — that clearing the marking leaves nothing
to trim and Find again marks it as found, and trims the box: the piece's
volume within half a percent of the box above the fracture, the piece shown
over the scan ghosted, reading a hundredth off the part, and the Gap view's
legend up. It exports the piece and reads the STL back — its sides and top
the box's, its bottom the fracture — trims again 0.15 mm off the break and
checks a slice that thick went, keeps the other side and checks it is what
overlapped the block, steps that back with Ctrl+Z, and puts the tool away:
the piece stays in view over the scan ghosted, listed in the parts list with
the scan and the box, and each eye shows and hides its part — the piece
alone with the box over it, and the scan back. It runs in the app's
`npm run e2e:ci`.

## Licences

The workspace ships two libraries, both permissive and used unmodified:
[meshoptimizer](https://github.com/zeux/meshoptimizer) (© Arseny Kapoulkine,
MIT) for the reduction, and [Manifold](https://github.com/elalish/manifold)
(`manifold-3d`, © The Manifold Authors, Apache-2.0) for the booleans. Both
are WebAssembly loaded when first used, both pinned without a caret, and
the imprint names them (`ui/MeshNotices.tsx`).

## Roadmap

- Mesh Tools: keeping sharp edges crisp through the reduction
