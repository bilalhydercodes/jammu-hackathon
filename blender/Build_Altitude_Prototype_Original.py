"""ALTITUDE — automatic Blender prototype and 120-second presentation.

RUN IN BLENDER: Scripting > Text > Open > select this file > Alt+P.
No add-ons, downloads, paid services or external assets are required.
Creates a NEW scene; existing objects/scenes are preserved.
Saves a timestamped .blend under your Documents/Altitude_Prototype folder.
Does not automatically start the long animation render.

Written for Blender's 4.x/5.x API with runtime property checks.
Syntax-checked outside Blender; this environment cannot execute Blender.
Concept visualization, not fabrication CAD or a validated thermal/wiring design.
"""

import bpy
import math
import random
import os
import traceback
from datetime import datetime
from pathlib import Path
from mathutils import Vector

FPS = 24
DURATION = 120
# 50% gives a 960 x 540 first preview; use the included panel for Full HD.
PREVIEW_PERCENT = 50
PREFIX = 'ALTITUDE_'
S = None
COL = None
M = {}
OUT = None


def link(obj):
    COL.objects.link(obj)
    return obj


def assign(obj, mat):
    if mat:
        obj.data.materials.append(mat)
    return obj


def material(name, color, metal=0.0, rough=.4, alpha=1, emission=0):
    mat = bpy.data.materials.new(PREFIX + name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, alpha)
    bs = mat.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, alpha)
    bs.inputs['Metallic'].default_value = metal
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Alpha'].default_value = alpha
    if emission:
        for key in ('Emission Color', 'Emission'):
            if key in bs.inputs:
                bs.inputs[key].default_value = (*color, 1)
                break
        if 'Emission Strength' in bs.inputs:
            bs.inputs['Emission Strength'].default_value = emission
    if alpha < 1:
        try:
            mat.surface_render_method = 'DITHERED'
        except (AttributeError, TypeError):
            try:
                mat.blend_method = 'BLEND'
            except (AttributeError, TypeError):
                pass
    M[name] = mat
    return mat


def cube(name, loc, size, mat=None, bevel=.025, parent=None):
    x, y, z = (v / 2 for v in size)
    verts = [(-x,-y,-z), (x,-y,-z), (x,y,-z), (-x,y,-z),
             (-x,-y,z), (x,-y,z), (x,y,z), (-x,y,z)]
    faces = [(0,3,2,1), (4,5,6,7), (0,1,5,4), (1,2,6,5),
             (2,3,7,6), (3,0,4,7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = link(bpy.data.objects.new(name, mesh))
    obj.location = loc
    obj.parent = parent
    assign(obj, mat)
    if bevel:
        mod = obj.modifiers.new('Machined edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
    return obj


def cylinder(name, loc, radius, depth, mat, axis='Z', sides=32, parent=None):
    verts = []
    for z in (-depth/2, depth/2):
        verts.extend((radius*math.cos(i*math.tau/sides), radius*math.sin(i*math.tau/sides), z)
                     for i in range(sides))
    faces = [tuple(reversed(range(sides))), tuple(range(sides, sides*2))]
    faces += [(i, (i+1)%sides, (i+1)%sides+sides, i+sides) for i in range(sides)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = link(bpy.data.objects.new(name, mesh))
    obj.location = loc
    obj.parent = parent
    if axis == 'X':
        obj.rotation_euler[1] = math.pi/2
    elif axis == 'Y':
        obj.rotation_euler[0] = math.pi/2
    for poly in mesh.polygons[2:]:
        poly.use_smooth = True
    assign(obj, mat)
    mod = obj.modifiers.new('Edge finish', 'BEVEL')
    mod.width = min(.012, depth/8, radius/8)
    mod.segments = 2
    return obj


def empty(name, loc=(0,0,0)):
    obj = link(bpy.data.objects.new(name, None))
    obj.location = loc
    return obj


def text(name, body, loc, size=.12, mat=None, rotation=(0,0,0), parent=None, align='LEFT'):
    data = bpy.data.curves.new(name, 'FONT')
    data.body = body
    data.size = size
    data.align_x = align
    data.extrude = .0004
    data.resolution_u = 4
    obj = link(bpy.data.objects.new(name, data))
    obj.location = loc
    obj.rotation_euler = rotation
    obj.parent = parent
    return assign(obj, mat or M['white'])


def tube(name, points, radius, mat, smooth=True):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.resolution_u = 12
    data.bevel_depth = radius
    data.bevel_resolution = 3
    data.use_fill_caps = True
    if smooth:
        spline = data.splines.new('BEZIER')
        spline.bezier_points.add(len(points)-1)
        for p, xyz in zip(spline.bezier_points, points):
            p.co = xyz
            p.handle_left_type = 'AUTO'
            p.handle_right_type = 'AUTO'
    else:
        spline = data.splines.new('POLY')
        spline.points.add(len(points)-1)
        for p, xyz in zip(spline.points, points):
            p.co = (*xyz, 1)
    return assign(link(bpy.data.objects.new(name, data)), mat)


def linear_keys(obj):
    """Both legacy and layered Action layouts are supported."""
    ad = getattr(obj, 'animation_data', None)
    if not ad or not ad.action:
        return
    action = ad.action
    curves = []
    try:
        curves.extend(action.fcurves)
    except AttributeError:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in getattr(strip, 'channelbags', []):
                    curves.extend(bag.fcurves)
    for curve in curves:
        for key in curve.keyframe_points:
            key.interpolation = 'LINEAR'


def visible_between(obj, start, end):
    # Render visibility is discrete; tiny scale hides objects in viewport too.
    original_scale = obj.scale.copy()
    for f, hide in [(1, True), (max(1,start-1), True), (start, False),
                    (end, False), (end+1, True)]:
        obj.hide_render = hide
        obj.keyframe_insert(data_path='hide_render', frame=f)
        obj.scale = (.000001,)*3 if hide else original_scale
        obj.keyframe_insert(data_path='scale', frame=f)


def bolt(loc, parent=None):
    cylinder('Socket head fastener', loc, .055, .055, M['steel'], sides=16, parent=parent)
    cylinder('Hex socket', (loc[0],loc[1],loc[2]+.03), .024, .004, M['black'], sides=6, parent=parent)


def board(name, center, size):
    x,y,z = center
    w,h = size
    cube(name, center, (w,h,.055), M['pcb'], .014)
    for dx in (-w/2+.09,w/2-.09):
        for dy in (-h/2+.09,h/2-.09):
            cylinder('PCB brass standoff', (x+dx,y+dy,z-.09), .043,.16,M['brass'], sides=12)
            bolt((x+dx,y+dy,z+.05))
    return center


def connector(loc, pins=4):
    x,y,z = loc
    cube('Harness connector', loc, (.08*pins+.06,.15,.14), M['black'], .008)
    for i in range(pins):
        cube('Contact pin', (x+(i-(pins-1)/2)*.08,y-.10,z), (.025,.10,.028), M['brass'], .003)


def flow_path(name, pts, color):
    tube(name+' clear hose', pts, .072, M['clear'])
    curve = tube(name+' coolant', pts, .045, color)
    curve.data.use_path = True
    curve.data.path_duration = 100
    # Visual tracers only: cumulative time is frozen throughout the fault.
    # Low-demand circulation 56-68 s; cooling event 78-88 s; restored at 114 s.
    clock = '(min(max(frame-1344,0),288)*0.65+min(max(frame-1872,0),240)*1.4+max(frame-2736,0)*0.65)'
    for i in range(6):
        tracer = cylinder(name+' flow tracer', (0,0,0), .056,.065,M['tracer'], sides=8)
        con = tracer.constraints.new('FOLLOW_PATH')
        con.target = curve
        con.use_fixed_location = True
        driver = con.driver_add('offset_factor').driver
        driver.expression = f'(({clock})*0.012+{i/6})%1'
    return curve


def set_video():
    r = S.render
    try:
        if hasattr(r.image_settings, 'media_type'):
            r.image_settings.media_type = 'VIDEO'
        else:
            r.image_settings.file_format = 'FFMPEG'
        r.ffmpeg.format = 'MPEG4'
        r.ffmpeg.codec = 'H264'
        r.ffmpeg.constant_rate_factor = 'MEDIUM'
        r.filepath = str(OUT / 'Altitude_Presentation.mp4')
        return True
    except (AttributeError, TypeError, ValueError):
        if hasattr(r.image_settings, 'media_type'):
            r.image_settings.media_type = 'IMAGE'
        r.image_settings.file_format = 'PNG'
        r.filepath = str(OUT / 'frames' / 'frame_')
        (OUT/'frames').mkdir(exist_ok=True)
        return False


def build_materials():
    material('shell', (.085,.14,.19), .78,.29)
    material('steel', (.42,.53,.58), .88,.24)
    material('black', (.009,.017,.025), .1,.36)
    material('pcb', (.015,.105,.062), .22,.39)
    material('brass', (.6,.34,.065), .8,.28)
    material('copper', (.65,.22,.085), .85,.28)
    material('ceramic', (.72,.81,.85), .1,.35)
    material('battery', (.075,.16,.24), .42,.32)
    material('blue', (.015,.4,.62), .25,.23)
    material('hot', (.95,.18,.035), .2,.27)
    material('clear', (.65,.85,.95), .0,.14,.20)
    material('white', (.8,.9,1), .0,.45, emission=.7)
    material('muted', (.34,.52,.65), .0,.45, emission=.3)
    material('cyan', (.01,.5,.8), .1,.35, emission=1.0)
    material('green', (.04,.7,.23), .0,.3, emission=1.5)
    material('red', (.9,.02,.035), .0,.3, emission=1.2)
    material('amber', (.95,.42,.015), .0,.3, emission=1.3)
    material('tracer', (.35,.8,1), .0,.35, emission=1.8)
    material('hud', (.004,.011,.018), .0,1, emission=.3)
    material('stage', (.014,.024,.04), .3,.4)
    material('snow', (.48,.61,.72), .0,.85)


def build_enclosure():
    # Dimensions are illustrative Blender units, not manufacturing tolerances.
    cube('Rugged aluminum base', (0,0,.76), (7.6,5.4,.22), M['shell'], .08)
    for x in (-3.36,3.36):
        for y in (-2.24,2.24):
            cylinder('Vibration isolator', (x,y,.56), .21,.24,M['black'])
    cube('Rear enclosure wall', (0,2.62,1.83), (7.6,.16,2.12),M['shell'],.04)
    for x in (-3.72,3.72):
        cube('Side enclosure wall', (x,0,1.83), (.16,5.12,2.12),M['shell'],.04)
    cube('Dry / wet sealed divider', (.55,0,1.69), (.10,5.08,1.72),M['shell'],.025)
    cube('Battery partition', (-1.57,-1.28,1.24), (4.12,.07,.70),M['shell'],.01)
    for x in (-2.95,-.2,1.3,3.12):
        cube('Equipment mounting rail', (x,0,.93), (.11,4.65,.12),M['steel'],.014)
    for x in (-3.45,3.45):
        for y in (-2.3,2.3):
            bolt((x,y,.91))
    front = empty('Front service panel assembly', (0,-2.63,1.83))
    cube('Front service panel', (0,0,0), (7.6,.16,2.12),M['shell'],.045,front)
    cube('OLED bezel', (-1.43,-.103,.25), (2.22,.07,.83),M['black'],.035,front)
    cube('OLED glass', (-1.43,-.148,.25), (2.04,.014,.64),M['hud'],.01,front)
    text('Exterior OLED', 'SYSTEM NORMAL\n24.6 V   |   31.2 C',(-2.36,-.166,.40),.15,M['cyan'],(math.pi/2,0,0),front)
    cylinder('Emergency stop mount', (1.87,-.17,.14), .34,.15,M['black'],'Y',parent=front)
    cylinder('Emergency stop mushroom', (1.87,-.31,.14), .25,.20,M['red'],'Y',parent=front)
    text('E-stop label','E-STOP',(1.48,-.18,-.44),.14,M['white'],(math.pi/2,0,0),front)
    cube('Master switch bezel',(.50,-.18,.08),(.34,.12,.48),M['black'],.025,front)
    cube('Master rocker',(.50,-.26,.08),(.22,.09,.34),M['steel'],.03,front)
    text('Power label','POWER',(.23,-.18,-.44),.13,M['white'],(math.pi/2,0,0),front)
    for x in (-3.02,2.88):
        cylinder('Sealed bulkhead connector',(x,-.16,-.39),.17,.23,M['steel'],'Y',parent=front)
        cylinder('Connector insert',(x,-.3,-.39),.105,.026,M['black'],'Y',parent=front)
    for i in range(5):
        cube('Pressure vent grille',(3.12,-.104,.37+i*.07),(.48,.03,.027),M['black'],.004,front)
    # Front is explicitly removed for the demonstrative cutaway; no coolant on PCB.
    for f, y in [(1,-2.63),(312,-2.63),(456,-4.8),(2712,-4.8),(2808,-2.63),(2880,-2.63)]:
        front.location.y=y
        front.keyframe_insert(data_path='location', frame=f)
    lid = empty('Lid and gasket exploded assembly', (0,0,2.99))
    cube('Sealed lid',(0,0,0),(7.65,5.44,.20),M['shell'],.07,lid)
    for x in (-3.57,3.57):
        cube('Long lid gasket',(x,0,-.12),(.065,5.05,.052),M['black'],.022,lid)
    for y in (-2.5,2.5):
        cube('Short lid gasket',(0,y,-.12),(7.15,.065,.052),M['black'],.022,lid)
    for x in (-3.44,3.44):
        for y in (-2.29,2.29):
            bolt((x,y,.135),lid)
    cube('Lid nameplate',(-.1,0,.117),(4.45,1.55,.035),M['black'],.06,lid)
    text('Product name','ALTITUDE',(-1.93,.12,.143),.48,M['white'],parent=lid)
    text('Product subtitle','INTELLIGENT EQUIPMENT PROTECTION',(-1.94,-.4,.143),.13,M['cyan'],parent=lid)
    for f,z in [(1,2.99),(240,2.99),(432,5.5),(2712,5.5),(2808,2.99),(2880,2.99)]:
        lid.location.z=z
        lid.keyframe_insert(data_path='location',frame=f)
    # Hide roof and front between inspection and reassembly, including children.
    for root in (lid,front):
        for ob in [root]+list(root.children_recursive):
            for f,hide in [(1,False),(479,False),(480,True),(2711,True),(2712,False)]:
                ob.hide_render=hide
                ob.keyframe_insert(data_path='hide_render',frame=f)
    return front,lid


def build_electronics():
    board('Controller carrier PCB',(-1.88,.80,1.20),(2.87,1.57))
    cube('ESP32-S3 shield',(-1.99,.74,1.32),(1.08,.78,.18),M['steel'],.035)
    text('ESP module engraving','ESP32-S3',(-2.42,.72,1.417),.16,M['black'])
    # Antenna meander and proper connector pads.
    for i in range(5):
        cube('PCB antenna copper',(-1.42+i*.12,1.12,1.234),(.052,.33,.005),M['brass'],.002)
    for x in (-2.71,-1.17):
        for y in [0.34+i*.11 for i in range(9)]:
            cube('Soldered header',(x,y,1.30),(.08,.06,.14),M['black'],.004)
    random.seed(5)
    for i in range(22):
        x=random.uniform(-3.17,-.60);y=random.choice([.22,1.36])
        cube('SMD resistor or capacitor',(x,y,1.25),(.075,.045,.045),M['black'],.004)
    connector((-2.85,.14,1.30),4)
    connector((-.92,.14,1.30),4)
    # Protected load and a solid thermal bridge through an illustrative bulkhead.
    cube('Protected electronics board',(-1.95,-.51,1.18),(2.55,.91,.065),M['pcb'],.01)
    cube('Electronics heat spreader',(-1.63,-.48,1.40),(2.25,.74,.32),M['steel'],.025)
    for i in range(12):
        cube('Heatsink fin',(-2.63+i*.18,-.48,1.66),(.06,.73,.28),M['steel'],.014)
    cube('Cold-side conduction bridge',(-.20,-.43,1.39),(1.05,.59,.16),M['copper'],.02)
    cube('Bulkhead thermal interface',(.55,-.43,1.39),(.16,.73,.58),M['black'],.02)
    cube('Peltier cold ceramic',(.70,-.43,1.40),(.07,.55,.53),M['ceramic'],.01)
    cube('Peltier semiconductor layer',(.76,-.43,1.40),(.04,.49,.46),M['black'],.006)
    cube('Peltier hot ceramic',(.82,-.43,1.40),(.06,.55,.53),M['ceramic'],.01)
    cube('Liquid hot-side heat exchanger',(1.05,-.43,1.40),(.38,.72,.67),M['copper'],.025)
    text('Controller ID','CONTROLLER',(-3.23,1.74,1.06),.16,M['muted'])
    text('Thermal ID','COLD > TEC > HOT',(-.26,-.96,1.06),.12,M['amber'])
    # Enclosed battery, fused pack output, and BMS PCB.
    cube('Battery cradle',(-2.04,-1.94,1.10),(2.63,1.02,.36),M['black'],.025)
    for i in range(6):
        cylinder('Battery cell',(-3.04+i*.40,-1.94,1.40),.17,.84,M['battery'],'Y')
        cylinder('Cell terminal',(-3.04+i*.40,-2.37,1.40),.085,.025,M['steel'],'Y')
    for y in (-2.18,-1.72):
        cube('Battery retaining strap',(-2.04,y,1.59),(2.64,.10,.06),M['black'],.009)
    board('Integrated BMS board',(-.24,-1.96,1.25),(.67,.90))
    for y in (-2.16,-1.95,-1.74):
        cube('BMS protection MOSFET',(-.23,y,1.32),(.27,.13,.09),M['black'],.008)
    text('BMS ID','BMS',(-.51,-2.47,1.07),.14,M['amber'])
    cube('Pack fuse holder',(-.13,-1.24,1.24),(.45,.22,.24),M['red'],.022)
    board('Power distribution and driver PCB',(-.01,.98,1.20),(.68,1.72))
    for j in range(4):
        cube('Driver package',(-.01,.46+j*.33,1.29),(.38,.20,.11),M['black'],.012)
    cylinder('Buck inductor',(-.01,1.45,1.39),.15,.23,M['copper'])
    text('Power ID','POWER / INA260',(-.51,1.95,1.08),.12,M['muted'])
    # Routed harnesses, keeping to the dry compartment.
    tube('Protected DC supply',[(-.10,-1.27,1.35),(.29,-1.0,1.15),(.29,.8,1.20),(.10,1.0,1.30)],.025,M['red'])
    tube('Controller power harness',[(-.12,.48,1.32),(-.45,.32,1.15),(-.90,.14,1.32)],.021,M['black'])
    tube('BMS telemetry harness',[(-.4,-1.72,1.33),(-.53,-1.0,1.08),(-3.33,-.95,1.10),(-3.33,.02,1.15),(-2.86,.14,1.32)],.018,M['blue'])
    for i,(x,y,z) in enumerate([(-2.55,-.40,1.85),(-2.6,-1.82,1.59),(.01,.79,1.36)]):
        cylinder('Bonded temperature probe',(x,y,z),.047,.08,M['black'])
        tube('Sensor signal pair',[(x,y,z),(-3.39,y,1.12),(-3.39,.12,1.12),(-2.92,.14,1.32)],.012,M['blue'])
    board('Vented BME280 sensor',(-3.3,1.99,1.35),(.32,.32))
    cube('BME280 sensing package',(-3.3,1.99,1.40),(.16,.14,.045),M['steel'],.006)
    tube('Vented pressure port',[(-3.3,2.02,1.43),(-3.3,2.30,1.65),(-3.3,2.56,1.65)],.055,M['black'])
    tube('BME280 signal harness',[(-3.26,1.92,1.36),(-3.20,1.60,1.10),(-2.82,1.4,1.27)],.012,M['blue'])
    cube('Safety relay body',(.01,2.00,1.30),(.43,.32,.36),M['amber'],.035)
    text('Safety relay ID','NC SAFETY',(-.39,2.28,1.10),.11,M['muted'])


def build_cooling():
    # Reservoir in isolated service compartment, with wall-mounted brackets.
    cylinder('Reservoir base',(2.42,1.35,1.11),.46,.18,M['black'])
    cylinder('Transparent reservoir',(2.42,1.35,1.82),.43,1.30,M['clear'])
    cylinder('Reservoir screw cap',(2.42,1.35,2.51),.46,.16,M['steel'])
    liquid=cylinder('Reservoir coolant level',(2.42,1.35,1.64),.38,.96,M['blue'])
    for f,h in [(1,.96),(2040,.96),(2112,.20),(2376,.20),(2712,.20),(2736,.96),(2880,.96)]:
        liquid.scale.z=h/.96
        liquid.location.z=1.16+h/2
        liquid.keyframe_insert(data_path='scale',frame=f)
        liquid.keyframe_insert(data_path='location',frame=f)
    cube('Reservoir lower clamp',(2.42,1.78,1.25),(.95,.16,.12),M['steel'],.02)
    cube('Reservoir upper clamp',(2.42,1.78,2.29),(.95,.16,.12),M['steel'],.02)
    cube('Reservoir bracket',(2.42,2.15,1.77),(.20,.79,1.45),M['steel'],.02)
    cylinder('Coolant level probe',(2.05,1.35,1.31),.065,.14,M['amber'],'X')
    tube('Level probe cable',[(1.98,1.35,1.31),(1.55,1.7,1.1),(.61,1.8,1.1),(.33,1.8,1.2),(.10,1.30,1.30)],.016,M['black'])
    cube('Pump mounting bracket',(2.49,-1.52,1.05),(.95,.82,.14),M['steel'],.025)
    cylinder('Pump motor',(2.49,-1.60,1.34),.33,.73,M['black'],'Y')
    cylinder('Pump volute',(2.49,-1.19,1.34),.36,.16,M['steel'],'Y')
    cylinder('Pump inspection window',(2.49,-1.09,1.34),.26,.02,M['clear'],'Y')
    rotor=empty('Pump impeller animation',(2.49,-1.075,1.34))
    for i in range(5):
        blade=cube('Pump impeller blade',(0,0,0),(.045,.032,.41),M['blue'],.01,rotor)
        blade.rotation_euler.y=i*math.tau/5
    drv=rotor.driver_add('rotation_euler',1).driver
    drv.expression='(min(max(frame-1344,0),288)*0.65+min(max(frame-1872,0),240)*1.4+max(frame-2736,0)*0.65)*0.28'
    for x in (2.14,2.84):
        for y in (-1.80,-1.28):bolt((x,y,1.15))
    # Finned radiator is outside the right side wall, with sealed bulkhead fittings.
    cube('External radiator core',(4.04,.45,1.73),(.43,2.64,1.57),M['black'],.04)
    for j in range(27):
        cube('Radiator fin',(4.08,-.81+j*.098,1.73),(.62,.025,1.50),M['steel'],.008)
    for y in (-.88,1.78):
        cube('Radiator header',(4.04,y,1.73),(.65,.13,1.61),M['shell'],.025)
    cube('Radiator protected fan frame',(4.45,.44,1.75),(.14,1.50,1.50),M['black'],.03)
    fan=empty('Radiator fan',(4.56,.44,1.75))
    cylinder('Fan hub',(0,0,0),.16,.12,M['steel'],'X',parent=fan)
    for j in range(7):
        a=j*math.tau/7
        blade=cube('Fan blade',(0,.34*math.cos(a),.34*math.sin(a)),(.045,.50,.18),M['black'],.025,fan)
        blade.rotation_euler.x=a
    fan.driver_add('rotation_euler',0).driver.expression=drv.expression
    for j in range(9):
        cube('Fan guard',(4.65,-.24+j*.17,1.75),(.032,.032,1.48),M['steel'],.008)
    pts=[[(2.30,1.05,1.28),(2.12,.68,1.20),(2.07,-.65,1.16),(2.49,-1.07,1.34)],
         [(2.70,-1.18,1.34),(2.98,-.93,1.50),(2.6,-.48,1.76),(1.15,-.14,1.70)],
         [(1.15,-.73,1.70),(1.6,-.96,1.81),(3.1,-.62,1.83),(3.68,-.38,1.83),(3.91,-.38,1.83)],
         [(3.91,1.26,1.83),(3.68,1.26,1.83),(3.13,1.66,2.10),(2.65,1.46,2.26)]]
    for i,p in enumerate(pts):
        flow_path('Coolant segment '+str(i+1),p,M['hot'] if i==2 else M['blue'])
        for end in (p[0],p[-1]):
            cylinder('Hose clamp / fitting',end,.092,.10,M['steel'])
    for y in (-.38,1.26):
        cylinder('Sealed coolant bulkhead',(3.72,y,1.83),.14,.19,M['steel'],'X')
    tube('Pump protected power',[(2.49,-1.80,1.30),(1.50,-2.33,1.10),(.60,-2.35,1.10),(.34,-2.35,1.13),(.30,.34,1.17),(.10,.45,1.30)],.025,M['black'])
    tube('Peltier supply',[(.78,-.67,1.36),(.63,-.88,1.16),(.30,-.88,1.10),(.29,.65,1.14),(.10,.74,1.31)],.018,M['red'])
    text('Wet bay label','THERMAL SERVICE',(1.05,2.16,1.09),.18,M['muted'])
    text('Pump label','PUMP',(2.12,-2.22,1.05),.17,M['white'])


def light(name, loc, power, size, color, target=(0,0,1)):
    data=bpy.data.lights.new(name,'AREA')
    data.energy=power
    data.shape='DISK'
    data.size=size
    data.color=color
    obj=link(bpy.data.objects.new(name,data))
    obj.location=loc
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def stage():
    cube('Presentation plinth',(0,0,.12),(10.9,8.0,.46),M['stage'],.16)
    cube('Studio floor',(0,0,-.20),(200,200,.12),M['stage'],.02)
    text('Plinth title','ALTITUDE / ENGINEERING PROTOTYPE',(-4.64,-3.5,.36),.23,M['muted'])
    text('Plinth concept label','HIGH-ALTITUDE EQUIPMENT PROTECTION',(-4.64,-3.82,.36),.14,M['muted'])
    # Distant faceted terrain silhouettes evoke altitude without competing with hardware.
    rng=random.Random(33)
    for i in range(11):
        x=-27+i*5.2;y=24+rng.uniform(-2,6);h=rng.uniform(3,9);r=rng.uniform(3.5,6)
        mesh=bpy.data.meshes.new('Distant mountain')
        mesh.from_pydata([(x-r,y-r,-.1),(x+r,y-r,-.1),(x+r,y+r,-.1),(x-r,y+r,-.1),(x,y,h)],[],[(0,1,4),(1,2,4),(2,3,4),(3,0,4),(0,3,2,1)])
        assign(link(bpy.data.objects.new('Mountain silhouette',mesh)),M['snow'])
    world=bpy.data.worlds.new('Altitude studio world')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs[0].default_value=(.09,.13,.21,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.35
    S.world=world
    light('Large soft key',(-4,-6,11),2200,7,(.73,.87,1))
    light('Warm edge light',(6,4,7),2500,5,(1,.73,.46))
    light('Front fill',(0,-8,5),1200,6,(.42,.7,1))
    light('Top strip',(0,0,10),1300,5,(.9,.95,1))


SHOTS=[
    (0,10,'ALTITUDE','Intelligent equipment protection', (11,-14,10),(9,-13,9),(0,0,1.8),
     'A 3D concept prototype for high-altitude environments.'),
    (10,20,'ENGINEERED ENCLOSURE','Sealed joints / vented housing / service access',(10,-13,10),(11,-11,10),(0,0,2.4),
     'The lid lifts and the front panel withdraws for inspection.'),
    (20,32,'INSIDE THE PROTOTYPE','Dry electronics and isolated thermal service',(8,-11,12),(5,-10,12),(0,0,1.3),
     'Mounted boards, routed harnesses and a separate battery bay.'),
    (32,44,'SENSING + CONTROL','ESP32-S3 / temperature / environment / power',(-5,-5,8),(-3,-4,7),(-1.6,.4,1.3),
     'Bonded probes and a vented BME280 inform the controller.'),
    (44,56,'THE PELTIER INTERFACE','Load > cold plate > Peltier > hot-side exchanger',(3,-5,6),(2.5,-4.5,5.5),(.0,-.4,1.5),
     'Hot-side rejection includes load heat and Peltier electrical input.'),
    (56,68,'CLOSED COOLANT LOOP','Reservoir > pump > hot block > radiator',(8,-8,9),(9,-5,8),(2.1,.2,1.6),
     'Flow tracers illustrate direction; they are not a fluid simulation.'),
    (68,76,'NORMAL OPERATION','SYSTEM NORMAL / monitoring active',(6,-9,10),(7,-8,10),(-.2,0,1.5),
     'Low thermal demand: pump and Peltier are idle.'),
    (76,88,'THERMAL DEMAND RISES','Establish circulation, then enable cooling',(6,-7,8),(5,-6,7),(1,-.4,1.5),
     'The pump and fan start; the status changes to active cooling.'),
    (88,99,'COOLANT LOW','PUMP OFF / PELTIER OFF / fault alarm',(7,-7,8),(6,-6,7),(2.1,.2,1.6),
     'Low level disables cooling before the fault indication appears.'),
    (99,106,'BATTERY PROTECTION','BMS: CHARGE INHIBITED',(-4,-6,7),(-3,-5,6),(-1.9,-1.9,1.4),
     'The BMS enforces cell protection; the ESP32-S3 reports status.'),
    (106,114,'HARDWIRED SHUTDOWN','NC safety circuit / independent of firmware',(4,-7,10),(3,-6,9),(.0,.8,1.4),
     'The safety contact removes pump and Peltier power; logic stays on.'),
    (114,120,'INTELLIGENT RELIABILITY','Monitoring / cooling / protection',(10,-13,10),(12,-15,11),(0,0,2.1),
     'Closing sequence: service completed, verified reset and reassembly.'),
]


def cameras():
    for index,(start,end,title,subtitle,loc1,loc2,target,caption) in enumerate(SHOTS):
        data=bpy.data.cameras.new('Shot '+str(index+1))
        data.lens=42
        data.clip_start=.05
        data.clip_end=250
        cam=link(bpy.data.objects.new(f'{index+1:02d} / {title}',data))
        focus=empty('Camera focal target '+str(index),target)
        con=cam.constraints.new('TRACK_TO')
        con.target=focus
        con.track_axis='TRACK_NEGATIVE_Z'
        con.up_axis='UP_Y'
        data.dof.use_dof=False  # laptop-friendly; all engineering labels stay sharp
        for f,loc in [(start*FPS+1,loc1),(end*FPS,loc2)]:
            cam.location=loc
            cam.keyframe_insert(data_path='location',frame=f)
        linear_keys(cam)
        marker=S.timeline_markers.new(title,frame=start*FPS+1)
        marker.camera=cam
        if index==0:S.camera=cam
        # Camera-parented type provides stable, legible presentation titles.
        # At 42 mm / 36 mm sensor and z=.9, frame width is .7714 units.
        objs=[]
        objs.append(cube('Title band',(0,.166,-.91),(.79,.10,.003),M['hud'],0,cam))
        objs.append(text('Shot title',title,(-.344,.17,-.90),.021,M['white'],parent=cam))
        objs.append(text('Shot subtitle',subtitle,(-.344,.143,-.90),.010,M['cyan'],parent=cam))
        objs.append(cube('Caption band',(0,-.186,-.91),(.79,.058,.003),M['hud'],0,cam))
        objs.append(text('Shot caption',caption,(-.344,-.181,-.90),.0085,M['white'],parent=cam))
        objs.append(text('Concept note','CONCEPT VISUALIZATION  /  ILLUSTRATIVE HARDWARE  /  '+f'{index+1:02d} OF 12',(-.344,-.202,-.90),.0068,M['muted'],parent=cam))
        for ob in objs:visible_between(ob,start*FPS+1,end*FPS)


def status_display():
    # A display on the carrier board is visible during cutaway shots.
    cube('Internal OLED board',(-1.78,1.95,1.22),(1.43,.56,.10),M['black'],.02)
    for name,body,mat,a,b in [
        ('startup','STARTUP',M['cyan'],1,240),
        ('normal','SYSTEM NORMAL',M['green'],241,1872),
        ('cooling','COOLING ACTIVE',M['amber'],1873,2112),
        ('fault','COOLANT LOW',M['red'],2113,2376),
        ('battery','CHARGE INHIBIT',M['amber'],2377,2544),
        ('stop','E-STOP ACTIVE',M['red'],2545,2736),
        ('restored','SYSTEM NORMAL',M['green'],2737,2880)]:
        ob=text(name,body,(-2.41,1.94,1.28),.12,mat)
        visible_between(ob,a,b)
    # RGB beacon at the front left inside, color keyframes remain in the .blend.
    ledmat=material('status_led',(.03,.3,1),emission=2)
    cylinder('RGB status beacon',(-3.24,-1.10,1.29),.08,.09,ledmat)
    bs=ledmat.node_tree.nodes.get('Principled BSDF')
    em=bs.inputs.get('Emission Color') or bs.inputs.get('Emission')
    colors=[(1,(.03,.3,1,1)),(241,(.03,.8,.2,1)),(1873,(1,.42,.01,1)),
            (2113,(1,.01,.02,1)),(2377,(1,.42,.01,1)),(2545,(1,.01,.02,1)),(2737,(.03,.8,.2,1))]
    for f,c in colors:
        if f>1:
            for inp in (bs.inputs['Base Color'],em):
                inp.keyframe_insert(data_path='default_value',frame=f-1)
        for inp in (bs.inputs['Base Color'],em):
            inp.default_value=c
            inp.keyframe_insert(data_path='default_value',frame=f)


def install_panel():
    # Convenience controls for the current Blender session. Rendering also works
    # using the normal Render menu after reopening the saved project.
    class ALTITUDE_OT_quality(bpy.types.Operator):
        bl_idname='altitude.quality'
        bl_label='Set preview or final resolution'
        percent: bpy.props.IntProperty(default=50)
        def execute(self,context):
            context.scene.render.resolution_percentage=self.percent
            self.report({'INFO'},'Resolution set to '+str(self.percent)+'%')
            return {'FINISHED'}
    class ALTITUDE_OT_open_output(bpy.types.Operator):
        bl_idname='altitude.open_output'
        bl_label='Open Output Folder'
        def execute(self,context):
            bpy.ops.wm.path_open(filepath=context.scene.get('altitude_output',str(OUT)))
            return {'FINISHED'}
    class ALTITUDE_PT_help(bpy.types.Panel):
        bl_label='ALTITUDE / Render controls'
        bl_idname='ALTITUDE_PT_help'
        bl_space_type='VIEW_3D'
        bl_region_type='UI'
        bl_category='Altitude'
        def draw(self,context):
            layout=self.layout
            layout.label(text='Your 3D project is ready.')
            layout.operator('render.render',text='1. Preview Current Frame',icon='RENDER_STILL')
            row=layout.row()
            row.operator('altitude.quality',text='Fast 540p').percent=50
            row.operator('altitude.quality',text='Full HD').percent=100
            op=layout.operator('render.render',text='2. Render 120-second Video',icon='RENDER_ANIMATION')
            op.animation=True
            layout.operator('altitude.open_output',icon='FILE_FOLDER')
            layout.label(text='Esc cancels a render.')
    for cls in (ALTITUDE_OT_quality,ALTITUDE_OT_open_output,ALTITUDE_PT_help):
        old=getattr(bpy.types,cls.__name__,None)
        if old:
            try:bpy.utils.unregister_class(old)
            except RuntimeError:pass
        bpy.utils.register_class(cls)


def main():
    global S,COL,OUT
    stamp=datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    docs=Path.home()/'Documents'
    if not docs.is_dir():docs=Path.home()
    OUT=docs/'Altitude_Prototype'/stamp
    OUT.mkdir(parents=True,exist_ok=False)
    S=bpy.data.scenes.new('ALTITUDE / Hackathon Presentation')
    bpy.context.window.scene=S
    COL=bpy.data.collections.new('ALTITUDE / Complete Prototype')
    S.collection.children.link(COL)
    S.frame_start=1
    S.frame_end=DURATION*FPS
    S.render.fps=FPS
    S.render.resolution_x=1920
    S.render.resolution_y=1080
    S.render.resolution_percentage=PREVIEW_PERCENT
    for engine in ('BLENDER_EEVEE_NEXT','BLENDER_EEVEE'):
        try:
            S.render.engine=engine
            break
        except TypeError:
            continue
    else:
        S.render.engine='CYCLES'
        S.cycles.samples=16
        S.cycles.use_denoising=True
    try:S.view_settings.view_transform='AgX'
    except TypeError:pass
    S.view_settings.exposure=.35
    build_materials()
    stage()
    build_enclosure()
    build_electronics()
    build_cooling()
    cameras()
    status_display()
    video=set_video()
    S['altitude_output']=str(OUT)
    S['altitude_video_configured']=video
    S['design_note']='Concept presentation, not tested hardware or validated CAD. Flow tracers are illustrative.'
    S['preview_help']='Render > Render Image previews one frame. Render > Render Animation renders the timeline.'
    # Store instructions and script inside the project for later editing.
    guide=bpy.data.texts.new('START HERE - ALTITUDE')
    guide.write('Your project has been generated.\n\n'
                'First inspect a frame: Render > Render Image (F12).\n'
                'Close the render window to return.\n'
                'Play the 3D timeline: click Layout, put the mouse over the viewport, press Space.\n'
                'The viewport is a preview, not the finished lighting.\n'
                'Render the movie: Render > Render Animation (Ctrl+F12).\n'
                'It can take a long time on a laptop. Start with one frame.\n'
                'Fast preview is 960x540. For 1920x1080 use Output Properties > Resolution > 100%.\n'
                'For 4K set 3840x2160 and 100%; render time increases substantially.\n'
                'Current session: Layout > N > Altitude provides convenient render buttons.\n'
                'After reopening the .blend, use the normal Render menu. No script permissions needed.\n\n'
                'This version has no audio track.\n'
                'This is an editable concept model, not a measured reconstruction or CAD validation.\n'
                'Output folder: '+str(OUT)+'\n'
                +('MP4 export configured.\n' if video else 'This Blender build uses PNG frame output; send a screenshot for export help.\n'))
    install_panel()
    S.frame_set(600)  # Begin with a revealing internal 3D shot.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.region_3d.view_perspective='CAMERA'
                area.spaces.active.region_3d.view_camera_zoom=0
                area.spaces.active.shading.type='MATERIAL'
                area.spaces.active.overlay.show_overlays=False
    if 'Layout' in bpy.data.workspaces:
        bpy.context.window.workspace=bpy.data.workspaces['Layout']
    # Some workspaces can remember a different scene; explicitly restore ours.
    bpy.context.window.scene=S
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'Altitude_Prototype.blend'))
    print('\nALTITUDE READY\nSaved to: '+str(OUT)+'\nUse Render > Render Image for your first preview.')
    def draw(self,context):
        self.layout.label(text='Your 3D prototype is ready and saved.')
        self.layout.label(text='Next: Render > Render Image (F12).')
        self.layout.label(text='Video: Render > Render Animation (Ctrl+F12).')
    bpy.context.window_manager.popup_menu(draw,title='ALTITUDE / Ready',icon='CHECKMARK')


if __name__=='__main__':
    try:
        main()
    except Exception:
        details=traceback.format_exc()
        print(details)
        try:
            report=bpy.data.texts.new('ALTITUDE - Build Error')
            report.write(details)
        except Exception:
            pass
        def error_popup(self,context):
            self.layout.label(text='Please send a screenshot of the error.')
            self.layout.label(text='Details are in the text: ALTITUDE - Build Error.')
        try:bpy.context.window_manager.popup_menu(error_popup,title='Build needs a compatibility fix',icon='ERROR')
        except Exception:pass
        raise
