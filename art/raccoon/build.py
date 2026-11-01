"""Procedural 3D raccoon mascot for the Leslieville Stink Reporter.

Run with Blender 4.5:
    blender -b -P art/raccoon/build.py -- --mood 1 --frame 0 --res 512 --samples 32 --fur 0 --out /tmp/a.png

Everything is built from code so the character can be regenerated and restyled:
shapes are unioned with a voxel remesh, smoothed, then painted with per-vertex colour
that the fur inherits. Each body part is rigid and pivots at its joint, and the fur
hides the seams.
"""
import argparse
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--mood", type=int, default=2)
ap.add_argument("--frame", type=int, default=0)
ap.add_argument("--frames", type=int, default=48)
ap.add_argument("--res", type=int, default=512)
ap.add_argument("--samples", type=int, default=32)
ap.add_argument("--fur", type=int, default=0)
ap.add_argument("--out", default="/tmp/raccoon.png")
ap.add_argument("--alpha", type=int, default=0)
ap.add_argument("--voxel", type=float, default=0.018)
ap.add_argument("--blend", default="")
ap.add_argument("--end", type=int, default=-1, help="render frames [frame, end) in this process")
ap.add_argument("--step", type=int, default=1)
ap.add_argument("--shot", default="hero", help="hero | icon | mark")
args = ap.parse_args(argv)

for _o in list(bpy.data.objects):
    bpy.data.objects.remove(_o)

# Scene colours are the site's heat ramp, so the render sits in the page's palette.
MOOD_BG = {1: "#D8E8D6", 2: "#F1E6BD", 3: "#ECCB87", 4: "#DCA171", 5: "#C77A6E"}


def lin(hex_color):
    h = hex_color.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


FUR = np.array(lin("#8A8177"))
FUR_MID = np.array(lin("#5E564E"))
DARK = np.array(lin("#1E1A18"))
CREAM = np.array(lin("#F2ECE0"))
TAN = np.array(lin("#BFB3A2"))
PAD = np.array(lin("#2B2523"))


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def wobble(p, f=9.0, amp=0.03):
    """Irregular edges for painted markings, so they read as fur rather than vector shapes."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    return amp * (np.sin(x * f + 1.3 * np.sin(z * f * 0.7)) + np.sin(z * f * 1.4 + y * f) + np.sin(y * f * 0.8 + x * f * 1.7)) / 3


def mix(a, b, t):
    t = t[:, None]
    return a * (1 - t) + b * t


# ── Geometry helpers ────────────────────────────────────────────────────────

def ell(center, radii, rot=(0, 0, 0)):
    return Matrix.Translation(center) @ Euler([math.radians(r) for r in rot]).to_matrix().to_4x4() @ Matrix.Diagonal((*radii, 1))


def tube(points, radii, step=0.5):
    """Chain of spheres along a polyline, for limbs."""
    out = []
    for i in range(len(points) - 1):
        a, b = Vector(points[i]), Vector(points[i + 1])
        ra, rb = radii[i], radii[i + 1]
        n = max(2, int((b - a).length / (min(ra, rb) * step)))
        for k in range(n + 1):
            t = k / n
            r = ra + (rb - ra) * t
            out.append(ell(a.lerp(b, t), (r, r, r)))
    return out


def blob(name, shapes, voxel=None, iters=14, parent=None, loc=(0, 0, 0)):
    voxel = voxel or args.voxel
    bm = bmesh.new()
    for m in shapes:
        bmesh.ops.create_uvsphere(bm, u_segments=28, v_segments=18, radius=1.0, matrix=m)
    me = bpy.data.meshes.new(name + "_src")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    r = ob.modifiers.new("r", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.use_smooth_shade = True
    s = ob.modifiers.new("s", "SMOOTH")
    s.factor = 0.7
    s.iterations = iters
    dg = bpy.context.evaluated_depsgraph_get()
    done = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    ob.data = done
    bpy.data.meshes.remove(me)
    for p in done.polygons:
        p.use_smooth = True
    if parent:
        ob.parent = parent
    ob.location = loc
    return ob


def paint(ob, fn, length=None, density=None):
    """Write a corner colour attribute from a numpy function of local position."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    p = co.reshape(-1, 3)
    col = np.clip(fn(p), 0, 1)
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    li = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", li)
    flat = np.ones((len(li), 4))
    flat[:, :3] = col[li]
    attr.data.foreach_set("color", flat.ravel())
    me.color_attributes.active_color = attr
    me.materials.append(M_SKIN)
    if length is not None:
        g = ob.vertex_groups.new(name="furlen")
        w = np.clip(length(p), 0.02, 1)
        for i, v in enumerate(w):
            g.add([i], float(v), "REPLACE")
        d = ob.vertex_groups.new(name="furden")
        w = np.clip(density(p) if density else np.ones(len(p)), 0.0, 1)
        for i, v in enumerate(w):
            d.add([i], float(v), "REPLACE")


# ── Materials ───────────────────────────────────────────────────────────────

def mat_paint():
    m = bpy.data.materials.new("skin")
    m.use_nodes = True
    n = m.node_tree
    b = n.nodes["Principled BSDF"]
    c = n.nodes.new("ShaderNodeVertexColor")
    c.layer_name = "Col"
    n.links.new(c.outputs[0], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    b.inputs["Specular IOR Level"].default_value = 0.12
    return m


def mat_fur():
    m = bpy.data.materials.new("fur")
    m.use_nodes = True
    n = m.node_tree
    n.nodes.clear()
    o = n.nodes.new("ShaderNodeOutputMaterial")
    h = n.nodes.new("ShaderNodeBsdfHairPrincipled")
    c = n.nodes.new("ShaderNodeVertexColor")
    c.layer_name = "Col"
    h.parametrization = "COLOR"
    h.inputs["Roughness"].default_value = 0.42
    h.inputs["Radial Roughness"].default_value = 0.55
    n.links.new(c.outputs[0], h.inputs["Color"])
    n.links.new(h.outputs[0], o.inputs["Surface"])
    return m


def mat(name, color, rough=0.5, metal=0.0, spec=0.5, emit=None, emit_s=1.0, alpha=None, trans=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(color), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Transmission Weight"].default_value = trans
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(emit), 1)
        b.inputs["Emission Strength"].default_value = emit_s
    if alpha is not None:
        b.inputs["Alpha"].default_value = alpha
    return m


M_SKIN = mat_paint()
M_FUR = mat_fur()
M_NOSE = mat("nose", "#141110", 0.18, spec=0.8)
M_EYE = mat("eye", "#0D0806", 0.1, spec=0.28)
M_IRIS = mat("iris", "#26130A", 0.12, spec=0.3)
M_SPARK = mat("spark", "#FFFFFF", 0.3, emit="#FFFFFF", emit_s=9.0)
M_LID = mat("lid", "#272220", 0.8, spec=0.2)
M_LASH = mat("lash", "#C4BAAD", 0.6)
M_MOUTH = mat("mouth", "#1A1412", 0.6)
M_INSIDE = mat("inside", "#6E2A2A", 0.45)
M_TONGUE = mat("tongue", "#C4605E", 0.35)
M_WHISK = mat("whisker", "#EDE6DA", 0.4)
M_TEAR = mat("tear", "#BFE3F2", 0.03, spec=1.0, trans=0.75, emit="#7EC4E0", emit_s=0.25)


def assign(ob, m):
    ob.data.materials.clear()
    ob.data.materials.append(m)


def add_fur(ob, count, length, children=7, comb=(0, 0, -0.05)):
    if not args.fur:
        return
    ob.data.materials.append(M_FUR)
    mod = ob.modifiers.new("fur", "PARTICLE_SYSTEM")
    ps = mod.particle_system
    s = ps.settings
    s.type = "HAIR"
    s.count = count
    s.hair_length = length
    s.hair_step = 4
    s.display_step = 3
    s.render_step = 4
    s.emit_from = "FACE"
    s.use_even_distribution = True
    s.material = 2
    s.factor_random = 0.006
    s.tangent_factor = 0.0
    s.object_align_factor = comb
    s.child_type = "INTERPOLATED"
    s.child_percent = 3
    s.rendered_child_count = children
    s.clump_factor = 0.45
    s.clump_shape = 0.15
    s.child_length = 0.85
    s.child_length_threshold = 0.5
    s.roughness_1 = 0.018
    s.roughness_endpoint = 0.035
    s.roughness_2 = 0.03
    s.root_radius = 1.0
    s.tip_radius = 0.08
    s.radius_scale = 0.0052
    s.shape = 0.2
    ps.vertex_group_length = "furlen"
    ps.vertex_group_density = "furden"


# ── Character ───────────────────────────────────────────────────────────────

root = bpy.data.objects.new("root", None)
bpy.context.collection.objects.link(root)

# Body. Origin on the floor under the hips.
body_shapes = [
    ell((0, 0, 0.62), (0.66, 0.56, 0.66)),
    ell((0, -0.05, 1.08), (0.47, 0.42, 0.46)),
    ell((0, 0.12, 0.42), (0.6, 0.52, 0.42)),
]
body = blob("body", body_shapes, parent=root)


def paint_body(p):
    c = np.tile(FUR, (len(p), 1))
    belly = ((p[:, 0] / 0.46) ** 2 + ((p[:, 2] - 0.62) / 0.6) ** 2 + (np.minimum(p[:, 1] + 0.3, 0) * 0) < 1.0 + wobble(p, 11, 0.15)) & (p[:, 1] < 0.1)
    c = mix(c, TAN, smooth(0.0, 1.0, belly.astype(float)))
    return mix(c, FUR_MID, smooth(0.2, 0.7, p[:, 1] + wobble(p, 7, 0.1)))


paint(body, paint_body)

# Head. Origin at the neck pivot, so tilts look natural.
HEAD = (0, -0.03, 1.26)
head_shapes = [
    ell((0, 0, 0.56), (0.74, 0.62, 0.58)),
    ell((0, -0.06, 0.8), (0.56, 0.5, 0.36)),
    ell((0, -0.6, 0.4), (0.3, 0.34, 0.23)),
    ell((0, -0.46, 0.53), (0.2, 0.34, 0.15)),
    ell((0.54, -0.06, 0.36), (0.26, 0.26, 0.22), (0, 0, 20)),
    ell((-0.54, -0.06, 0.36), (0.26, 0.26, 0.22), (0, 0, -20)),
    ell((0.74, -0.03, 0.27), (0.13, 0.1, 0.1), (0, 30, 14)),
    ell((-0.74, -0.03, 0.27), (0.13, 0.1, 0.1), (0, -30, -14)),
    ell((0.7, -0.03, 0.4), (0.11, 0.09, 0.09), (0, 10, 10)),
    ell((-0.7, -0.03, 0.4), (0.11, 0.09, 0.09), (0, -10, -10)),
]
head = blob("head", head_shapes, parent=body, loc=HEAD)


def paint_head(p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    ax = np.abs(x)
    w = wobble(p, 16, 0.035)
    c = np.tile(FUR, (len(p), 1))
    # Darker crown so the white brows and mask read against it.
    c = mix(c, FUR_MID, smooth(0.5, 0.82, z + w * 2) * 0.92)
    # Cheeks and jaw.
    cheek = ((ax - 0.52) / 0.3) ** 2 + ((z - 0.26) / 0.17) ** 2
    c = mix(c, TAN, smooth(1.15, 0.7, cheek + w * 6) * smooth(0.25, -0.1, y))
    jaw = smooth(0.3, 0.16, z + w)
    c = mix(c, TAN, jaw * smooth(0.1, -0.3, y))
    # White brow above each eye, tilted out.
    bx, bz = (ax - 0.33) / 0.19, (z - 0.885 + 0.3 * (ax - 0.33)) / 0.058
    brow = smooth(1.2, 0.7, np.sqrt(bx ** 2 + bz ** 2) + w * 7)
    c = mix(c, CREAM, brow * (y < 0.1))
    # Forehead stripe running up from the nose.
    stripe = smooth(0.14, 0.06, ax + w * 0.6) * smooth(0.5, 0.64, z)
    c = mix(c, DARK, stripe * (y < 0.3) * 0.9)
    # The mask.
    mx, mz = (ax - 0.37) / 0.42, (z - 0.62 + 0.3 * (ax - 0.37)) / 0.175
    mask = smooth(1.12, 0.82, np.sqrt(mx ** 2 + mz ** 2) + w * 5)
    c = mix(c, DARK, mask * (y < 0.05))
    # Muzzle.
    mq = (x / 0.33) ** 2 + ((z - 0.38) / 0.22) ** 2 + ((y + 0.72) / 0.36) ** 2
    c = mix(c, CREAM, smooth(1.1, 0.75, mq + w * 4))
    return c


def head_length(p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    ax = np.abs(x)
    w = np.ones(len(p))
    # Shorter on the face than on the crown and back of the head.
    w = np.minimum(w, 0.5 + 0.5 * np.maximum(smooth(-0.5, -0.05, y), smooth(0.62, 0.85, z)))
    # Nearly none around the eyes and nose.
    eye = np.sqrt(((ax - 0.31) / 0.2) ** 2 + ((z - 0.62) / 0.16) ** 2)
    w = np.minimum(w, 0.05 + 0.75 * smooth(0.8, 1.5, eye + (y > -0.1) * 2))
    nose = np.sqrt((x / 0.14) ** 2 + ((z - 0.46) / 0.12) ** 2)
    w = np.minimum(w, 0.05 + 0.5 * smooth(0.8, 1.6, nose + (y > -0.6) * 2))
    return w




def head_density(p):
    ax, y, z = np.abs(p[:, 0]), p[:, 1], p[:, 2]
    eye = np.sqrt(((ax - 0.285) / 0.17) ** 2 + ((z - 0.62) / 0.15) ** 2) + (y > -0.15) * 3
    nose = np.sqrt((p[:, 0] / 0.12) ** 2 + ((z - 0.48) / 0.1) ** 2) + (y > -0.65) * 3
    return np.minimum(smooth(0.72, 1.1, eye), smooth(0.8, 1.2, nose)) * 0.97 + 0.03


paint(head, paint_head, head_length, head_density)

# Eyes and lids. Lid angles are posed per mood.
EYE_C = (0.285, -0.54, 0.62)
EYE_R = 0.135


def sphere(name, center, radii, material, parent, segs=32):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=segs // 2, radius=1.0, matrix=ell((0, 0, 0), radii))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    ob.location = center
    assign(ob, material)
    return ob


def hemisphere(name, r, parent, center):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=r)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.002], context="VERTS")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    ob.location = center
    assign(ob, M_LID)
    ob.rotation_mode = "XYZ"
    return ob


eyes = {}
for side, sx in (("L", -1), ("R", 1)):
    c = (sx * EYE_C[0], EYE_C[1], EYE_C[2])
    eye = sphere("eye" + side, c, (EYE_R, EYE_R, EYE_R), M_EYE, head)
    iris = sphere("iris" + side, (0, -EYE_R * 0.84, 0), (EYE_R * 0.62, EYE_R * 0.22, EYE_R * 0.62), M_IRIS, eye)
    pupil = sphere("pupil" + side, (0, -EYE_R * 0.05, 0), (EYE_R * 0.54, EYE_R * 0.2, EYE_R * 0.54), M_EYE, iris)
    spark = sphere("spark" + side, (-EYE_R * 0.32, -EYE_R * 0.9, EYE_R * 0.38), (EYE_R * 0.19, EYE_R * 0.05, EYE_R * 0.19), M_SPARK, eye, segs=12)
    spark2 = sphere("sparkb" + side, (EYE_R * 0.3, -EYE_R * 0.92, -EYE_R * 0.26), (EYE_R * 0.08, EYE_R * 0.03, EYE_R * 0.08), M_SPARK, eye, segs=10)
    up = hemisphere("lidU" + side, EYE_R * 1.1, head, c)
    lo = hemisphere("lidD" + side, EYE_R * 1.08, head, c)
    eyes[side] = dict(eye=eye, up=up, lo=lo, parts=(eye, iris, pupil, spark, spark2))

nose = sphere("nose", (0, -0.885, 0.49), (0.105, 0.075, 0.08), M_NOSE, head)
nose.hide_render = args.mood == 5



def paint_ear(p):
    r = np.sqrt((p[:, 0] / 0.26) ** 2 + ((p[:, 2] - 0.14) / 0.32) ** 2)
    c = np.tile(FUR_MID, (len(p), 1))
    c = mix(c, DARK, smooth(0.85, 0.5, r) * (p[:, 1] < 0.02))
    return mix(c, CREAM, smooth(0.72, 1.0, r + wobble(p, 18, 0.06)))


ears = {}
for side, sx in (("L", -1), ("R", 1)):
    ear = blob("ear" + side, [ell((0, 0, 0.14), (0.25, 0.1, 0.31))], voxel=0.012, iters=8, parent=head, loc=(sx * 0.52, 0.1, 0.95))
    paint(ear, paint_ear, lambda p: 0.45 + 0.4 * smooth(0.5, 1.0, np.sqrt((p[:, 0] / 0.26) ** 2 + ((p[:, 2] - 0.14) / 0.32) ** 2)))
    ear.rotation_mode = "XYZ"
    ears[side] = ear

# Mouth: a dark line drawn on the muzzle, with a curve per mood.


def line(name, pts, radius, material, parent):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("NURBS")
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (*p, 1)
    sp.use_endpoint_u = True
    sp.order_u = min(4, len(pts))
    cu.bevel_depth = radius
    cu.bevel_resolution = 3
    cu.resolution_u = 8
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    cu.materials.append(material)
    return ob


line("philtrum", [(0, -0.9, 0.42), (0, -0.915, 0.36), (0, -0.905, 0.32)], 0.009, M_MOUTH, head)

MOUTHS = {
    1: [(-0.13, -0.8, 0.33), (-0.06, -0.88, 0.3), (0, -0.905, 0.32), (0.06, -0.88, 0.3), (0.13, -0.8, 0.33)],
    2: [(-0.1, -0.84, 0.3), (-0.05, -0.895, 0.295), (0, -0.905, 0.31), (0.05, -0.895, 0.295), (0.1, -0.84, 0.3)],
    3: [(-0.12, -0.82, 0.285), (-0.05, -0.895, 0.3), (0, -0.905, 0.31), (0.05, -0.895, 0.3), (0.12, -0.82, 0.285)],
}
if args.mood in MOUTHS:
    line("mouth", MOUTHS[args.mood], 0.0095, M_MOUTH, head)
elif args.mood == 4:
    sphere("mouthopen", (0, -0.86, 0.255), (0.1, 0.05, 0.075), M_INSIDE, head)
    sphere("tongue", (0, -0.885, 0.235), (0.06, 0.03, 0.035), M_TONGUE, head)

for sx in (-1, 1):
    for i, (zz, spread, drop) in enumerate(((0.44, 0.1, 0.0), (0.4, 0.16, -0.06), (0.36, 0.1, -0.12))):
        a = (sx * 0.2, -0.76, zz)
        b = (sx * 0.5, -0.72 + spread * 0.2, zz + 0.04 + drop * 0.3)
        d = (sx * 0.82, -0.56 + spread, zz + 0.02 + drop)
        if args.mood != 5:
            line(f"whisk{sx}{i}", [a, b, d], 0.0034, M_WHISK, head)

# Arms hang from the shoulder. Hands are dark, as on a real raccoon.


def arm_shapes():
    s = tube([(0, 0, 0), (0, -0.03, -0.32), (0, -0.05, -0.66)], [0.17, 0.135, 0.115])
    s.append(ell((0, -0.07, -0.76), (0.135, 0.11, 0.13)))
    for i, x in enumerate((-0.09, -0.03, 0.03, 0.09)):
        s.append(ell((x, -0.1, -0.87 + abs(x) * 0.5), (0.034, 0.034, 0.075)))
    return s


def paint_arm(p):
    return mix(np.tile(FUR_MID, (len(p), 1)), DARK, smooth(-0.34, -0.6, p[:, 2] + wobble(p, 16, 0.05)))


arms = {}
for side, sx in (("L", -1), ("R", 1)):
    a = blob("arm" + side, arm_shapes(), voxel=0.014, iters=8, parent=body, loc=(sx * 0.42, -0.08, 1.05))
    paint(a, paint_arm, lambda p: smooth(-0.86, -0.5, p[:, 2]) * 0.6 + 0.12)
    a.rotation_mode = "XYZ"
    arms[side] = a

# Legs. Sitting pose by default; rotated at the hip for the run.


def leg_shapes(sx):
    s = [ell((0, 0, 0), (0.33, 0.39, 0.33))]
    s += tube([(0, -0.1, -0.1), (0, -0.28, -0.2)], [0.22, 0.17])
    s.append(ell((sx * 0.02, -0.42, -0.2), (0.17, 0.3, 0.1)))
    for i, x in enumerate((-0.1, -0.035, 0.035, 0.1)):
        s.append(ell((sx * 0.02 + x, -0.71, -0.22), (0.042, 0.06, 0.045)))
    return s


def paint_leg(p):
    return mix(np.tile(FUR, (len(p), 1)), DARK, smooth(-0.3, -0.5, p[:, 1] + wobble(p, 14, 0.05)))


legs = {}
for side, sx in (("L", -1), ("R", 1)):
    l = blob("leg" + side, leg_shapes(sx), voxel=0.016, iters=10, parent=body, loc=(sx * 0.46, -0.16, 0.31))
    paint(l, paint_leg, lambda p: smooth(-0.72, -0.35, p[:, 1]) * 0.7 + 0.15)
    l.rotation_mode = "XYZ"
    legs[side] = l

# Tail: a ringed bushy tube, skinned to a bone chain so it can curl and flick.
TAIL_N = 5
TAIL_LEN = 1.7


def tail_path(t):
    x = -0.98 * math.sin(t * 1.5)
    y = 0.15 * math.sin(t * 2.0)
    z = 0.05 + 0.95 * t * t + 0.1 * t
    return Vector((x, y, z))


def tail_radius(t):
    return 0.14 + 0.15 * math.sin(min(t * 1.25, 1) * math.pi * 0.72) ** 0.8 * (1 - 0.15 * t) if t < 0.9 else (0.14 + 0.15 * math.sin(0.9 * 1.25 * math.pi * 0.72) ** 0.8 * 0.865) * math.sqrt(max(0, 1 - ((t - 0.9) / 0.1) ** 2)) + 0.002


tail_pts = [tail_path(i / 60) for i in range(61)]
tail_shapes = [ell(tail_pts[i], (tail_radius(i / 60),) * 3) for i in range(61)]
tail = blob("tail", tail_shapes, voxel=0.018, iters=10, parent=body, loc=(-0.34, 0.42, 0.24))


def tail_t(p):
    pts = np.array([tuple(v) for v in tail_pts])
    d = ((p[:, None, :] - pts[None, :, :]) ** 2).sum(axis=2)
    return d.argmin(axis=1) / 60


def paint_tail(p):
    t = tail_t(p)
    bands = 0.5 + 0.5 * np.cos(t * math.tau * 4.5 + 0.4 + wobble(p, 12, 0.5))
    c = mix(np.tile(TAN, (len(p), 1)), DARK, smooth(0.42, 0.58, bands))
    return mix(c, DARK, smooth(0.86, 0.93, t))


paint(tail, paint_tail, lambda p: np.ones(len(p)))
arm_ob = bpy.data.armatures.new("tailrig")
rig = bpy.data.objects.new("tailrig", arm_ob)
bpy.context.collection.objects.link(rig)
rig.parent = tail
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
prev = None
for i in range(TAIL_N):
    b = arm_ob.edit_bones.new(f"t{i}")
    b.head = tail_path(i / TAIL_N)
    b.tail = tail_path((i + 1) / TAIL_N)
    if prev:
        b.parent = prev
        b.use_connect = True
    prev = b
bpy.ops.object.mode_set(mode="OBJECT")
co = np.empty(len(tail.data.vertices) * 3)
tail.data.vertices.foreach_get("co", co)
ts = tail_t(co.reshape(-1, 3))
for i in range(TAIL_N):
    g = tail.vertex_groups.new(name=f"t{i}")
    centre = (i + 0.5) / TAIL_N
    w = np.clip(1 - np.abs(ts - centre) * TAIL_N * 0.75, 0, 1)
    for vi in np.nonzero(w)[0]:
        g.add([int(vi)], float(w[vi]), "REPLACE")
md = tail.modifiers.new("arm", "ARMATURE")
md.object = rig

# Fur last, so it sits after the armature in the stack.
add_fur(body, 3200, 0.11)
add_fur(head, 5200, 0.135, comb=(0, 0.022, -0.016))
add_fur(tail, 1500, 0.1)
for e_ in ears.values():
    add_fur(e_, 420, 0.05)
for a in arms.values():
    add_fur(a, 700, 0.075)
for l in legs.values():
    add_fur(l, 900, 0.085)

# ── Props ───────────────────────────────────────────────────────────────────


def rounded_box(name, size, taper=0.0, bevel=0.06, seg=4, material=None, parent=None, loc=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        k = 1 - taper * (0.5 - v.co.z)
        v.co.x *= size[0] * k
        v.co.y *= size[1] * k
        v.co.z *= size[2]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    b = ob.modifiers.new("b", "BEVEL")
    b.width = bevel
    b.segments = seg
    b.limit_method = "ANGLE"
    w = ob.modifiers.new("w", "WEIGHTED_NORMAL")
    for p in me.polygons:
        p.use_smooth = True
    ob.location = loc
    if parent:
        ob.parent = parent
    if material:
        me.materials.append(material)
    return ob


def ribbed(name, color):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree
    b = n.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(color), 1)
    b.inputs["Roughness"].default_value = 0.42
    w = n.nodes.new("ShaderNodeTexWave")
    w.wave_type = "BANDS"
    w.bands_direction = "X"
    w.inputs["Scale"].default_value = 3.1
    w.inputs["Distortion"].default_value = 0
    t = n.nodes.new("ShaderNodeTexCoord")
    n.links.new(t.outputs["Object"], w.inputs["Vector"])
    bu = n.nodes.new("ShaderNodeBump")
    bu.inputs["Strength"].default_value = 0.22
    bu.inputs["Distance"].default_value = 0.05
    n.links.new(w.outputs[0], bu.inputs["Height"])
    n.links.new(bu.outputs[0], b.inputs["Normal"])
    return m


bin_root = bpy.data.objects.new("bin", None)
bpy.context.collection.objects.link(bin_root)
M_BIN = ribbed("binmat", "#1F6A44")
M_LIDM = mat("binlid", "#17563A", 0.38)
M_RUBBER = mat("rubber", "#191817", 0.6)
M_LATCH = mat("latch", "#D9D3C4", 0.35)
rounded_box("binbody", (1.05, 1.1, 1.36), taper=0.1, bevel=0.07, material=M_BIN, parent=bin_root, loc=(0, 0, 0.72))
lid = rounded_box("binlid", (1.17, 1.22, 0.14), bevel=0.055, material=M_LIDM, parent=bin_root, loc=(0, 0, 1.44))
rounded_box("binlatch", (0.26, 0.05, 0.2), bevel=0.018, material=M_LATCH, parent=bin_root, loc=(0, -0.62, 1.32))
rounded_box("binhandle", (0.8, 0.09, 0.09), bevel=0.03, material=M_RUBBER, parent=bin_root, loc=(0, 0.62, 1.32))
for sx in (-1, 1):
    wh = sphere("wheel", (sx * 0.42, 0.5, 0.15), (0.075, 0.16, 0.16), M_RUBBER, bin_root)

# Scraps on the ground, Toronto raccoon reality.
M_CRUST = mat("crust", "#C98F4A", 0.55)
M_CHEESE = mat("cheese", "#F0C24B", 0.4)
M_PEP = mat("pep", "#A83A28", 0.45)
M_CAN = mat("can", "#C7CCD1", 0.22, metal=0.9)


def pizza(parent, loc, rot=(0, 0, 0), s=1.0):
    p = bpy.data.objects.new("pizza", None)
    bpy.context.collection.objects.link(p)
    p.parent = parent
    p.location = loc
    p.rotation_euler = [math.radians(r) for r in rot]
    p.scale = (s, s, s)
    bm = bmesh.new()
    a, b, c = Vector((0, -0.34, 0)), Vector((-0.2, 0.14, 0)), Vector((0.2, 0.14, 0))
    fv = [bm.verts.new(v) for v in (a, b, c)]
    f = bm.faces.new(fv)
    ex = bmesh.ops.extrude_face_region(bm, geom=[f])
    verts = [g for g in ex["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, 0.022), verts=verts)
    me = bpy.data.meshes.new("slice")
    bm.to_mesh(me)
    bm.free()
    so = bpy.data.objects.new("slice", me)
    bpy.context.collection.objects.link(so)
    so.parent = p
    bv = so.modifiers.new("b", "BEVEL")
    bv.width = 0.009
    bv.segments = 2
    me.materials.append(M_CHEESE)
    for pos in ((-0.04, -0.08), (0.05, 0.05), (-0.08, 0.08)):
        sphere("pep", (*pos, 0.024), (0.04, 0.04, 0.008), M_PEP, p, segs=16)
    line("crust", [(-0.2, 0.15, 0.02), (0, 0.19, 0.03), (0.2, 0.15, 0.02)], 0.042, M_CRUST, p)
    return p


# ── Set ─────────────────────────────────────────────────────────────────────

bg = MOOD_BG[args.mood]
M_SET = mat("set", bg, 0.8, spec=0.15, emit=bg, emit_s=0.3)
verts, faces = [], []
prof = [(-14, 0)] + [(4.0, 0)] + [(4.0 + 3.0 * math.sin(a), 3.0 - 3.0 * math.cos(a)) for a in np.linspace(0.08, math.pi / 2, 16)] + [(7.0, 14)]
for i, (y, z) in enumerate(prof):
    verts += [(-20, y, z), (20, y, z)]
    if i:
        k = i * 2
        faces.append((k - 2, k - 1, k + 1, k))
me = bpy.data.meshes.new("cyc")
me.from_pydata(verts, [], faces)
for p in me.polygons:
    p.use_smooth = True
me.materials.append(M_SET)
cyc = bpy.data.objects.new("cyc", me)
bpy.context.collection.objects.link(cyc)
cyc.is_shadow_catcher = bool(args.alpha)

# ── Lighting and camera ─────────────────────────────────────────────────────


def area(name, loc, target, size, energy, color="#FFFFFF"):
    l = bpy.data.lights.new(name, "AREA")
    l.shape = "RECTANGLE"
    l.size = size[0]
    l.size_y = size[1]
    l.energy = energy
    l.color = lin(color)
    ob = bpy.data.objects.new(name, l)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    d = Vector(target) - Vector(loc)
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return ob


area("key", (-3.4, -4.6, 5.2), (0, 0, 1.2), (4.5, 4.5), 165, "#FFF3E2")
area("fill", (4.5, -4.8, 2.0), (0, 0, 1.2), (5, 5), 34, "#E6EEFF")
area("rim", (2.6, 3.0, 4.2), (0, 0, 1.5), (3.5, 2), 130, "#FFF6EA")
w = bpy.data.worlds.new("w")
w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (*lin(bg), 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.5
bpy.context.scene.world = w

cam_d = bpy.data.cameras.new("cam")
cam_d.lens = 68
cam_d.dof.use_dof = True
cam_d.dof.aperture_fstop = 5.6
cam = bpy.data.objects.new("cam", cam_d)
bpy.context.collection.objects.link(cam)
cam.location = (-0.5, -7.25, 2.3)
tgt = Vector((0.14, 0, 1.19))
cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_d.dof.focus_distance = (Vector((0, -0.8, 1.9)) - cam.location).length
sc = bpy.context.scene
sc.camera = cam

# ── Mood extras ─────────────────────────────────────────────────────────────

rad = math.radians
M_CLOUD = bpy.data.materials.new("cloud")
M_CLOUD.use_nodes = True
_n = M_CLOUD.node_tree
_n.nodes.clear()
_o = _n.nodes.new("ShaderNodeOutputMaterial")
_m = _n.nodes.new("ShaderNodeMixShader")
_t = _n.nodes.new("ShaderNodeBsdfTransparent")
_e = _n.nodes.new("ShaderNodeEmission")
_e.inputs[0].default_value = (*lin("#A9C25A"), 1)
_e.inputs[1].default_value = 1.0
_lw = _n.nodes.new("ShaderNodeLayerWeight")
_lw.inputs[0].default_value = 0.5
_a = _n.nodes.new("ShaderNodeMath")
_a.operation = "SUBTRACT"
_a.inputs[0].default_value = 1.0
_a.use_clamp = True
_b = _n.nodes.new("ShaderNodeMath")
_b.operation = "POWER"
_b.inputs[1].default_value = 2.4
_c = _n.nodes.new("ShaderNodeMath")
_c.operation = "MULTIPLY"
_c.inputs[1].default_value = 0.24
_n.links.new(_lw.outputs["Facing"], _a.inputs[1])
_n.links.new(_a.outputs[0], _b.inputs[0])
_n.links.new(_b.outputs[0], _c.inputs[0])
_n.links.new(_c.outputs[0], _m.inputs[0])
_n.links.new(_t.outputs[0], _m.inputs[1])
_n.links.new(_e.outputs[0], _m.inputs[2])
_n.links.new(_m.outputs[0], _o.inputs["Surface"])
M_WISP = M_CLOUD.copy()
M_WISP.name = "wisp"
for _node in M_WISP.node_tree.nodes:
    if _node.type == "MATH" and _node.operation == "MULTIPLY":
        _node.inputs[1].default_value = 0.34
    if _node.type == "MATH" and _node.operation == "POWER":
        _node.inputs[1].default_value = 2.2
    if _node.type == "EMISSION":
        _node.inputs[0].default_value = (*lin("#9CB64C"), 1)

M_ZED = mat("zed", "#FFFDF2", 0.4, emit="#FFFDF2", emit_s=0.2)
M_DUST = mat("dust", "#F4E2D6", 0.9, emit="#F4E2D6", emit_s=0.3)
M_RUB = mat("maskrub", "#3F4E41", 0.5, spec=0.5)
M_RUBD = mat("maskdark", "#20261F", 0.45)
M_GLASS = mat("glass", "#BFE0B8", 0.08, spec=1.0, emit="#A7E08C", emit_s=0.7)
M_FILTER = mat("filter", "#6B7259", 0.34, metal=0.55)

WISPS = {2: 1, 3: 3, 4: 5, 5: 6}.get(args.mood, 0) if args.shot in ("hero", "share") else 0
wisps = []
PTS = 14
for i in range(WISPS):
    cu = bpy.data.curves.new(f"wisp{i}", "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("NURBS")
    sp.points.add(PTS - 1)
    sp.use_endpoint_u = True
    sp.order_u = 4
    cu.bevel_depth = 0.16
    cu.bevel_resolution = 4
    cu.resolution_u = 8
    cu.materials.append(M_WISP)
    ob = bpy.data.objects.new(f"wisp{i}", cu)
    bpy.context.collection.objects.link(ob)
    wisps.append(sp)

# (x, y, base height). In moods 2-4 the stink comes off the bin's lid.
WISP_SPOTS = {
    2: [(1.3, 0.9, 1.6)],
    3: [(1.08, 0.9, 1.6), (1.56, 0.86, 1.6), (-1.75, 1.0, 0.25)],
    4: [(1.0, 0.9, 1.6), (1.32, 0.86, 1.6), (1.66, 0.9, 1.6), (-1.7, 1.0, 0.25), (-2.1, 0.7, 0.2)],
    5: [(-2.5, 1.2, 0.5), (-1.9, 1.1, 0.7), (-1.35, 1.2, 0.5), (-2.15, 1.4, 1.0), (1.8, 1.1, 0.15), (2.2, 0.9, 0.15)],
}


def update_wisps(t):
    spots = WISP_SPOTS.get(args.mood, [])
    for i, sp in enumerate(wisps):
        x0, y0, z0 = spots[i]
        h = (1.05 if z0 > 0.4 else 1.7) + 0.26 * (i % 3)
        amp = 0.1 + 0.03 * (i % 3)
        ph = i * 0.37
        for k in range(PTS):
            u = k / (PTS - 1)
            sway = math.sin(math.tau * (1.25 * u - t * (1 + i % 2) + ph))
            sp.points[k].co = (x0 + amp * sway * (0.3 + u), y0, z0 + h * u + 0.05 * math.sin(math.tau * (t + ph)), 1)
            pulse = 0.72 + 0.28 * math.sin(math.tau * (t * (1 + i % 2) + ph))
            sp.points[k].radius = (math.sin(math.pi * u) ** 0.5) * pulse * (0.62 + 0.16 * (i % 2)) + 0.001


zeds = []
if args.mood == 1 and args.shot == "hero":
    for i, size in enumerate((0.26, 0.34, 0.42)):
        cu = bpy.data.curves.new(f"z{i}", "FONT")
        cu.body = "Z"
        cu.size = size
        cu.extrude = 0.03
        cu.bevel_depth = 0.012
        cu.bevel_resolution = 2
        cu.align_x = "CENTER"
        cu.align_y = "CENTER"
        cu.materials.append(M_ZED)
        ob = bpy.data.objects.new(f"z{i}", cu)
        bpy.context.collection.objects.link(ob)
        ob.rotation_euler = (rad(84), rad(-10), rad(-6))
        zeds.append(ob)


def update_zeds(t):
    for i, ob in enumerate(zeds):
        u = (t + i / 3) % 1
        fade = math.sin(math.pi * u) ** 0.6
        ob.scale = (fade, fade, fade)
        ob.location = (0.92 + 0.38 * u + 0.1 * math.sin(math.tau * u), -0.3, 2.28 + 0.62 * u)
        ob.rotation_euler = (rad(84), rad(-10 + 18 * u), rad(-6))


tears = []
if args.mood == 4:
    for sx in (-1, 1):
        for ph in (0.0, 0.5):
            tears.append((sphere("tear", (0, 0, 0), (0.032, 0.03, 0.044), M_TEAR, head, segs=16), sx, ph))


def update_tears(t):
    for ob, sx, ph in tears:
        u = (t * 2 + ph + (0.17 if sx > 0 else 0)) % 1
        ob.location = (sx * (0.34 + 0.2 * u), -0.62 + 0.14 * u, 0.5 - 0.4 * u - 0.32 * u * u)
        s_ = min(1.0, u * 6) * min(1.0, (1 - u) * 5)
        ob.scale = (s_, s_, s_ * (1 + 0.5 * u))


lines_ = []
puffs = []
# Soft gas clouds, denser as the mood worsens. Each drifts up, swells and fades on its own beat.
CLOUDS = {2: 4, 3: 9, 4: 16, 5: 20}.get(args.mood, 0) if args.shot in ("hero", "share") else 0
clouds = []
_rng = np.random.default_rng(11 + args.mood)
while len(clouds) < CLOUDS:
    # Gas stays behind the character and the bin, so it never tints them.
    cx_, cy_ = _rng.uniform(-3.0, 3.0), _rng.uniform(1.8, 3.2)
    if args.mood == 2:
        cx_ = _rng.uniform(0.6, 2.2)
    ob = sphere("cloud", (0, 0, 0), (1, 1, 1), M_CLOUD, None, segs=24)
    clouds.append((ob, cx_, cy_, _rng.uniform(0.0, 0.9), _rng.uniform(0.42, 0.85), int(_rng.integers(1, 3)), _rng.uniform(0, 1)))


def update_clouds(t):
    for ob, cx_, cy_, z0, size, speed, ph in clouds:
        u = (t * speed + ph) % 1
        fade = math.sin(math.pi * u) ** 0.8
        if args.mood == 5:
            ob.location = (cx_ - 1.0 * u + 0.5, cy_, z0 + 1.5 * u)
        else:
            ob.location = (cx_ + 0.14 * math.sin(math.tau * (u + ph)), cy_, z0 + 1.7 * u)
        r = size * (0.55 + 0.75 * u) * fade + 0.001
        ob.scale = (r, r, r * 0.86)


if args.mood == 5:
    # Gas mask, parented to the head so it follows every move.
    fp = blob("maskface", [ell((0, -0.34, 0.56), (0.68, 0.42, 0.53)), ell((0, -0.72, 0.38), (0.27, 0.25, 0.2))], voxel=0.016, iters=14, parent=head)
    fp.data.materials.append(M_RUB)
    for sx in (-1, 1):
        rim = sphere("lensrim", (sx * 0.29, -0.7, 0.66), (0.225, 0.05, 0.225), M_RUBD, head)
        rim.rotation_euler = (rad(-6), 0, rad(sx * 22))
        gl = sphere("lens", (sx * 0.31, -0.745, 0.66), (0.175, 0.03, 0.175), M_GLASS, head)
        gl.rotation_euler = (rad(-6), 0, rad(sx * 22))
        line(f"strap{sx}", [(sx * 0.62, -0.2, 0.74), (sx * 0.8, 0.2, 0.8), (sx * 0.5, 0.62, 0.86), (0, 0.72, 0.9)], 0.024, M_RUBD, head)
        line(f"strapb{sx}", [(sx * 0.62, -0.2, 0.32), (sx * 0.78, 0.2, 0.3), (sx * 0.5, 0.6, 0.34), (0, 0.68, 0.36)], 0.024, M_RUBD, head)
    bm = bmesh.new()
    rx = Matrix.Rotation(rad(90), 4, "X")
    bmesh.ops.create_cone(bm, cap_ends=True, segments=36, radius1=0.17, radius2=0.17, depth=0.2, matrix=Matrix.Translation((0, -1.04, 0.33)) @ rx)
    for off in (-0.09, 0.0, 0.09):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=36, radius1=0.188, radius2=0.188, depth=0.03, matrix=Matrix.Translation((0, -1.04 + off, 0.33)) @ rx)
    me = bpy.data.meshes.new("filter")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(M_FILTER)
    fo = bpy.data.objects.new("filter", me)
    bpy.context.collection.objects.link(fo)
    fo.parent = head
    sphere("grille", (0, -1.145, 0.33), (0.115, 0.02, 0.115), M_RUBD, head, segs=20)
    # Speed lines and dust.
    for i in range(6 if args.shot == "hero" else 0):
        lines_.append((sphere("speed", (0, 0, 0), (0.42 + 0.14 * (i % 3), 0.012, 0.012), M_ZED, None, segs=10), i))


def update_speed(t):
    for ob, i in lines_:
        u = (t * 2 + i / 6) % 1
        ob.location = (2.6 - 5.4 * u, 0.5 + 0.28 * (i % 3), 0.42 + 0.42 * i)
        f_ = math.sin(math.pi * u)
        ob.scale = (f_, 1, 1)
    for ob, i in puffs:
        u = (t * 2 + i / 4) % 1
        ob.location = (-0.15 - 1.7 * u, -0.45 + 0.1 * i, 0.08 + 0.32 * u)
        f_ = (math.sin(math.pi * min(1, u * 1.1)) ** 0.8) * (1.0 + 2.1 * u)
        ob.scale = (f_, f_, f_ * 0.82)


# ── Poses ───────────────────────────────────────────────────────────────────


arcs = {}
for side, sx in (("L", -1), ("R", 1)):
    cx, cy, cz = sx * EYE_C[0], EYE_C[1], EYE_C[2]
    r = EYE_R * 1.13
    # Sleeping eyes curve gently. Squeezed-shut eyes slope down toward the nose.
    slope = 0.075 * sx if args.mood == 4 else 0.0
    pts = [(cx + r * 0.86 * u, cy - r * math.sqrt(max(0.05, 1 - (0.86 * u) ** 2)), cz - 0.012 + 0.05 * u * u * (0.2 if args.mood == 4 else 1) + slope * u) for u in (-1, -0.5, 0, 0.5, 1)]
    arcs[side] = line("arc" + side, pts, 0.0135, M_LASH, head)
    arcs[side].hide_render = True


def set_eye(side, up, lo, look=(0, 0)):
    """up/lo are lid closure in degrees: 0 fully open, 90 meets at the eye's middle."""
    e = eyes[side]
    e["up"].rotation_euler = (rad(4 - (1 - up / 90) * 80), 0, 0)
    e["lo"].rotation_euler = (rad(176 + (1 - lo / 90) * 80), 0, 0)
    e["eye"].rotation_euler = (rad(look[1]), 0, rad(look[0]))
    closed = up >= 80 and lo >= 60
    for part in e["parts"]:
        part.hide_render = closed
    if arcs:
        arcs[side].hide_render = not closed


def set_tail(curl):
    for i, v in enumerate(curl):
        b = rig.pose.bones[f"t{i}"]
        b.rotation_mode = "XYZ"
        b.rotation_euler = tuple(rad(a) for a in v)


def pulse(t, centre, width):
    """Smooth 0..1 bump around centre, wrapping at the loop point."""
    d = abs((t - centre + 0.5) % 1 - 0.5)
    return 0.5 + 0.5 * math.cos(math.pi * min(1, d / width))


def pose(mood, t):
    """t runs 0..1 over one seamless loop."""
    wave = lambda n, phase=0.0: math.sin(math.tau * (n * t + phase))
    bin_root.location = (1.34, 0.86, 0)
    bin_root.rotation_euler = (0, 0, rad(-16))
    root.location = (-0.12, -0.25, 0)
    root.rotation_euler = (0, 0, rad(-8))
    body.rotation_euler = (rad(3), 0, 0)
    body.scale = (1, 1, 1)
    head.rotation_euler = (0, 0, 0)
    tail.rotation_euler = (0, 0, 0)
    nose.scale = (1, 1, 1)
    nose.location = (0, -0.885, 0.49)
    for s, sx in (("L", -1), ("R", 1)):
        # Hands rest forward on the knees, where they can be seen.
        arms[s].rotation_euler = (rad(-34), 0, rad(sx * -12))
        arms[s].scale = (1, 1, 1)
        legs[s].rotation_euler = (0, 0, rad(sx * 9))
        ears[s].rotation_euler = (0, rad(sx * 14), 0)
    sway = lambda a, n=1: [(0, 0, 0.32 * a * math.sin(math.tau * (n * t - i * 0.11))) for i in range(TAIL_N)]
    set_tail(sway(5))
    if mood == 1:
        breath = 0.5 + 0.5 * wave(2, -0.25)
        body.scale = (1 + 0.016 * breath, 1 + 0.024 * breath, 1 + 0.012 * breath)
        root.rotation_euler = (0, rad(6), rad(-4))
        root.location = (0.02, -0.15, 0)
        head.rotation_euler = (rad(13 - 3 * breath), rad(15), rad(8))
        arms["L"].rotation_euler = (rad(-66), 0, rad(30))
        arms["R"].rotation_euler = (rad(-62), 0, rad(-31))
        for s in "LR":
            set_eye(s, 90, 90)
        ears["R"].rotation_euler = (rad(-16 * pulse(t, 0.62, 0.035)), rad(14), 0)
        set_tail(sway(3))
    elif mood == 2:
        sniff = wave(5)
        turn = math.sin(math.tau * t) * 0.8 + 0.2 * wave(2, 0.1)
        head.rotation_euler = (rad(-13 + 1.5 * sniff), rad(4 * turn), rad(-12 + 15 * turn))
        nose.location = (0, -0.885 - 0.008 * sniff, 0.49 + 0.012 * sniff)
        nose.scale = (1 + 0.05 * sniff, 1, 1 + 0.03 * sniff)
        blink = max(pulse(t, 0.3, 0.03), pulse(t, 0.82, 0.03))
        for s in "LR":
            set_eye(s, 18 + 72 * blink, 3 + 87 * blink, look=(13 * turn, 5))
        ears["L"].rotation_euler = (rad(-20 * pulse(t, 0.48, 0.04)), rad(-14), 0)
        ears["R"].rotation_euler = (rad(-16 * pulse(t, 0.08, 0.04)), rad(14), 0)
        set_tail(sway(8))
    elif mood == 3:
        fan = wave(4)
        head.rotation_euler = (rad(4 + wave(2)), rad(-6), rad(15))
        arms["L"].rotation_euler = (rad(-111 + 7 * fan), 0, rad(38 + 15 * fan))
        arms["L"].scale = (1, 1, 1.2)
        blink = pulse(t, 0.55, 0.03)
        for s in "LR":
            set_eye(s, 46 + 44 * blink, 24 + 66 * blink, look=(-10, -3))
        ears["L"].rotation_euler = (rad(12), rad(-34), 0)
        ears["R"].rotation_euler = (rad(12), rad(34), 0)
        set_tail(sway(12, 2))
    elif mood == 4:
        shake = wave(8)
        body.rotation_euler = (rad(9), 0, rad(1.1 * shake))
        head.rotation_euler = (rad(4), 0, rad(1.5 * shake))
        arms["L"].rotation_euler = (rad(-110), 0, rad(35))
        arms["R"].rotation_euler = (rad(-110), 0, rad(-35))
        arms["L"].scale = arms["R"].scale = (1, 1, 1.46)
        for s, sx in (("L", -1), ("R", 1)):
            set_eye(s, 80, 62, look=(0, 6))
            arcs[s].rotation_euler = (0, 0, 0)
            arcs[s].location = (0, 0, 0)
        ears["L"].rotation_euler = (rad(22), rad(-52), 0)
        ears["R"].rotation_euler = (rad(22), rad(52), 0)
        set_tail(sway(6, 4))
    elif mood == 5:
        stride = wave(8)
        bounce = abs(wave(8, 0.25))
        root.location = (0.1, 0.05, 0.16 + 0.2 * bounce)
        root.rotation_euler = (0, 0, rad(42))
        body.rotation_euler = (rad(20 + 3 * wave(16)), 0, 0)
        head.rotation_euler = (rad(-12), 0, rad(-20))
        arms["L"].rotation_euler = (rad(-30 - 46 * stride), 0, 0)
        arms["R"].rotation_euler = (rad(-30 + 46 * stride), 0, 0)
        legs["L"].rotation_euler = (rad(58 * stride), 0, 0)
        legs["R"].rotation_euler = (rad(-58 * stride), 0, 0)
        for s in "LR":
            ears[s].rotation_euler = (rad(38), 0, 0)
        tail.rotation_euler = (0, 0, rad(-112))
        set_tail([(10, 0, 3.2 * math.sin(math.tau * (8 * t - i * 0.12))) for i in range(TAIL_N)])
        bin_root.location = (-1.95, 1.0, 0.62)
        bin_root.rotation_euler = (rad(4), rad(78), rad(24))


if args.mood == 1:
    pizza(arms["R"], (0.04, -0.17, -0.93), (84, 4, 28), 0.95)
if args.mood in (2, 3, 4) and args.shot in ("hero", "share"):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.085, radius2=0.085, depth=0.24, matrix=Matrix.Rotation(rad(90), 4, "Y"))
    for v in bm.verts:
        pinch = 1 - 0.34 * math.exp(-((v.co.x - 0.02) / 0.05) ** 2)
        v.co.y *= pinch
        v.co.z *= pinch
    me = bpy.data.meshes.new("can")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = abs(p.normal.x) < 0.8
    me.materials.append(mat("canred", "#C9382E", 0.3, metal=0.6))
    can = bpy.data.objects.new("can", me)
    bpy.context.collection.objects.link(can)
    can.location = (1.34, -1.0, 0.075)
    can.rotation_euler = (0, 0, rad(26))
    for sx in (-1, 1):
        sphere("canend", (sx * 0.12, 0, 0), (0.006, 0.07, 0.07), M_CAN, can, segs=20)

# ── Framing ─────────────────────────────────────────────────────────────────

if args.shot in ("icon", "mark"):
    bin_root.hide_render = True
    for ob in bin_root.children:
        ob.hide_render = True
if args.alpha:
    # Cut-outs sit on the page's paper colour, so light them neutrally with no set.
    cyc.hide_render = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 0.42
    # A white world mirrors off glossy eyes and greys them out.
    for m_ in (M_EYE, M_IRIS):
        m_.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
        m_.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.1

if args.shot == "icon":
    cam.location = (-0.5, -6.4, 2.25)
    tgt = Vector((-0.04 if args.mood != 5 else 0.1, 0, 1.38))
    cam_d.lens = 56
    cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
elif args.shot == "mark":
    cam_d.lens = 98
    cam_d.dof.use_dof = False
    for ob in (body, tail, *arms.values(), *legs.values()):
        ob.hide_render = True

# ── Render ──────────────────────────────────────────────────────────────────

sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = args.samples
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.04
sc.cycles.use_denoising = True
sc.cycles.denoiser = "OPENIMAGEDENOISE"
sc.cycles.seed = 7
sc.cycles.max_bounces = 6
sc.cycles.transmission_bounces = 4
sc.cycles.volume_bounces = 0
sc.cycles.caustics_reflective = False
sc.cycles.caustics_refractive = False
sc.render.resolution_x = args.res
sc.render.resolution_y = args.res
if args.shot == "share":
    # Link preview: wide, subject on the left, room on the right for the title.
    sc.render.resolution_x = int(args.res * 1200 / 630)
    cam_d.shift_x = 0.22
    cam_d.lens = 40
sc.render.film_transparent = bool(args.alpha)
sc.view_settings.view_transform = "Standard"
sc.view_settings.look = "None"
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA" if args.alpha else "RGB"
if args.blend:
    bpy.ops.wm.save_as_mainfile(filepath=args.blend)

end = args.end if args.end > args.frame else args.frame + 1
for frame in range(args.frame, end, args.step):
    t = frame / args.frames
    pose(args.mood, t)
    if args.shot == "mark":
        # Head-only logo: square to camera and centred, whatever the mood's pose.
        root.rotation_euler = (0, 0, 0)
        body.rotation_euler = (0, 0, 0)
        head.rotation_euler = (0, 0, 0)
        bpy.context.view_layer.update()
        tgt = head.matrix_world @ Vector((0, -0.2, 0.68))
        cam.location = tgt + Vector((-0.2, -5.6, 0.16))
        cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
    update_wisps(t)
    update_zeds(t)
    update_tears(t)
    update_speed(t)
    update_clouds(t)
    sc.render.filepath = args.out.replace("####", f"{frame:04d}")
    if os.path.exists(sc.render.filepath) and "####" in args.out:
        continue
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=True)
