(() => {
    // Everything below is in fresco.jpg pixel space (2400 x 1089).
    const FRESCO = { w: 2400, h: 1089 };
    const PIVOT = [1365.5, 398.4];     // inside God's sleeve
    const TIP = [913.3, 491.0];        // God's fingertip as painted
    const ADAM = [905.1, 499.9];       // Adam's fingertip
    const ARM_AT = [910, 367];
    const SLEEVE_AT = [1337, 303];
    // the sleeve's cuff; the arm is only ever drawn to the left of this line
    const CUFF = [[1356.6, 320.1], [1347.1, 347.3], [1339.6, 374.6], [1347.1, 395.0], [1370.9, 415.4],
                  [1384.6, 424.3], [1394.1, 433.8], [1416.6, 447.4], [1440.4, 454.9]];

    const ARM_LEN = Math.hypot(TIP[0] - PIVOT[0], TIP[1] - PIVOT[1]);
    const REST_ANG = Math.atan2(TIP[1] - PIVOT[1], TIP[0] - PIVOT[0]);
    const SWING = .42;                 // radians either side of the painted pose
    const MIN_REACH = .8;
    const MAX_REACH = 1.035;           // a little more arm is hidden in the sleeve

    // fresco-toned palette the dither snaps to
    const PALETTE = [
        '#1e140e', '#3d2616', '#5e3a24', '#8a6a44', '#b58a5c', '#d6ad82', '#e7d2b4', '#eee7d2',
        '#c9c2ae', '#9c9d9a', '#bdbcb5', '#5a1e1a', '#8a3a30', '#b26a5a', '#cbb3b8', '#6f8565',
        '#858e98', '#a9adb0',
    ];

    const view = document.getElementById('view');
    const scene = document.createElement('canvas');
    const sctx = scene.getContext('2d');
    const base = document.createElement('canvas');
    const bctx = base.getContext('2d');

    const load = src => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });

    let fresco, arm, sleeve;
    let lw, lh, px, cam;               // low-res size, pixel size, camera
    let gl, prog, tex, vctx;

    const pointer = { x: 0, y: 0, in: false };
    let ang = REST_ANG, reach = ARM_LEN;
    let flash = 0;
    const rings = [];

    // ---------- dither (WebGL2) ----------

    const VERT = `#version 300 es
        in vec2 p;
        void main() { gl_Position = vec4(p, 0., 1.); }`;

    const FRAG = `#version 300 es
        precision highp float;
        uniform sampler2D scene;
        uniform vec3 pal[${PALETTE.length}];
        uniform float spread;
        out vec4 outColor;
        const float bayer[64] = float[64](
             0.,32., 8.,40., 2.,34.,10.,42.,
            48.,16.,56.,24.,50.,18.,58.,26.,
            12.,44., 4.,36.,14.,46., 6.,38.,
            60.,28.,52.,20.,62.,30.,54.,22.,
             3.,35.,11.,43., 1.,33., 9.,41.,
            51.,19.,59.,27.,49.,17.,57.,25.,
            15.,47., 7.,39.,13.,45., 5.,37.,
            63.,31.,55.,23.,61.,29.,53.,21.);
        void main() {
            ivec2 size = textureSize(scene, 0);
            ivec2 p = ivec2(gl_FragCoord.xy);
            vec3 c = texelFetch(scene, ivec2(p.x, size.y - 1 - p.y), 0).rgb;
            float b = (bayer[(p.y & 7) * 8 + (p.x & 7)] + .5) / 64. - .5;
            c += b * spread;
            vec3 best = pal[0];
            float bd = 1e9;
            for (int i = 0; i < ${PALETTE.length}; i++) {
                vec3 d = c - pal[i];
                float dist = dot(d * d, vec3(.3, .59, .11));
                if (dist < bd) { bd = dist; best = pal[i]; }
            }
            outColor = vec4(best, 1.);
        }`;

    function setupGL() {
        gl = view.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
        if (!gl) return false;
        const sh = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
            return s;
        };
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        gl.useProgram(prog);

        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        const pal = PALETTE.flatMap(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
        gl.uniform3fv(gl.getUniformLocation(prog, 'pal'), pal);
        gl.uniform1f(gl.getUniformLocation(prog, 'spread'), .15);

        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return true;
    }

    // ---------- layout ----------

    function resize() {
        const vw = innerWidth, vh = innerHeight;
        px = Math.max(2, Math.round(vh / 380));
        lw = Math.ceil(vw / px);
        lh = Math.ceil(vh / px);
        scene.width = base.width = lw;
        scene.height = base.height = lh;
        view.width = lw;
        view.height = lh;
        view.style.width = lw * px + 'px';
        view.style.height = lh * px + 'px';

        // cover the screen, centred on the gap between the fingers (closer on portrait screens)
        const s = Math.max(lw / FRESCO.w, lh / FRESCO.h) * (vh > vw ? 1.2 : 1);
        const fx = (TIP[0] + ADAM[0]) / 2, fy = (TIP[1] + ADAM[1]) / 2;
        const ox = Math.min(0, Math.max(lw - FRESCO.w * s, lw / 2 - fx * s));
        const oy = Math.min(0, Math.max(lh - FRESCO.h * s, lh / 2 - fy * s));
        cam = { s, ox, oy };

        bctx.imageSmoothingQuality = 'high';
        bctx.setTransform(s, 0, 0, s, ox, oy);
        bctx.drawImage(fresco, 0, 0);
        bctx.drawImage(sleeve, SLEEVE_AT[0], SLEEVE_AT[1]);

        if (gl) gl.viewport(0, 0, lw, lh);
    }

    // ---------- interaction ----------

    function toFresco(e) {
        return [(e.clientX / px - cam.ox) / cam.s, (e.clientY / px - cam.oy) / cam.s];
    }

    view.addEventListener('pointermove', e => {
        [pointer.x, pointer.y] = toFresco(e);
        pointer.in = true;
    });
    view.addEventListener('pointerleave', () => { pointer.in = false; });
    view.addEventListener('pointerdown', e => {
        [pointer.x, pointer.y] = toFresco(e);
        pointer.in = true;
        const t = fingertip();
        const near = Math.hypot(t[0] - ADAM[0], t[1] - ADAM[1]) < 26;
        flash = near ? 1 : .45;
        rings.push({ x: t[0], y: t[1], r: 4, a: near ? 1 : .6 });
    });

    function fingertip() {
        return [PIVOT[0] + Math.cos(ang) * reach, PIVOT[1] + Math.sin(ang) * reach];
    }

    function wrap(a) {
        return Math.atan2(Math.sin(a), Math.cos(a));
    }

    // ---------- frame ----------

    function update(dt) {
        let ta = REST_ANG, tr = ARM_LEN;
        if (pointer.in) {
            const dx = pointer.x - PIVOT[0], dy = pointer.y - PIVOT[1];
            const off = Math.max(-SWING, Math.min(SWING, wrap(Math.atan2(dy, dx) - REST_ANG)));
            ta = REST_ANG + off;
            tr = Math.max(ARM_LEN * MIN_REACH, Math.min(ARM_LEN * MAX_REACH, Math.hypot(dx, dy)));
        }
        const k = 1 - Math.pow(.001, dt / 1000);   // frame-rate independent easing
        ang += wrap(ta - ang) * k;
        reach += (tr - reach) * k;

        // the fingertip is the cursor; show the real one only when it's out of reach
        const t = fingertip();
        const lost = pointer.in && Math.hypot(pointer.x - t[0], pointer.y - t[1]) * cam.s * px > 24;
        view.style.cursor = lost ? 'default' : 'none';

        flash *= Math.pow(.02, dt / 1000);
        for (let i = rings.length - 1; i >= 0; i--) {
            const r = rings[i];
            r.r += dt * .09;
            r.a *= Math.pow(.05, dt / 1000);
            if (r.a < .03) rings.splice(i, 1);
        }
    }

    function draw() {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.drawImage(base, 0, 0);

        sctx.setTransform(cam.s, 0, 0, cam.s, cam.ox, cam.oy);
        sctx.imageSmoothingQuality = 'high';

        // the arm, rotated about the shoulder and slid along its own length
        sctx.save();
        sctx.beginPath();
        sctx.moveTo(CUFF[0][0], -2000);
        for (const [x, y] of CUFF) sctx.lineTo(x, y);
        sctx.lineTo(CUFF[CUFF.length - 1][0], 4000);
        sctx.lineTo(-2000, 4000);
        sctx.lineTo(-2000, -2000);
        sctx.closePath();
        sctx.clip();
        const slide = reach - ARM_LEN;
        sctx.translate(PIVOT[0] + Math.cos(ang) * slide, PIVOT[1] + Math.sin(ang) * slide);
        sctx.rotate(ang - REST_ANG);
        sctx.translate(-PIVOT[0], -PIVOT[1]);
        sctx.drawImage(arm, ARM_AT[0], ARM_AT[1]);
        sctx.restore();

        // light in the gap: grows as the fingers close
        const t = fingertip();
        const gap = Math.hypot(t[0] - ADAM[0], t[1] - ADAM[1]);
        const near = Math.max(0, Math.min(1, (70 - gap) / 60));
        const glow = Math.min(1, near * near * .45 + flash * .7);
        if (glow > .01) {
            const mx = (t[0] + ADAM[0]) / 2, my = (t[1] + ADAM[1]) / 2;
            const rad = 22 + near * 18 + flash * 50;
            const g = sctx.createRadialGradient(mx, my, 0, mx, my, rad);
            g.addColorStop(0, `rgba(250,196,112,${glow * .75})`);
            g.addColorStop(.4, `rgba(236,172,96,${glow * .3})`);
            g.addColorStop(1, 'rgba(236,172,96,0)');
            sctx.fillStyle = g;
            sctx.fillRect(mx - rad, my - rad, rad * 2, rad * 2);
        }
        for (const r of rings) {
            sctx.strokeStyle = `rgba(255,205,130,${r.a * .8})`;
            sctx.lineWidth = 3 / cam.s;
            sctx.beginPath();
            sctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
            sctx.stroke();
        }
        sctx.globalCompositeOperation = 'source-over';

        if (gl) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        } else {
            vctx.drawImage(scene, 0, 0);
        }
    }

    let last = performance.now();
    function frame(now) {
        update(Math.min(100, now - last));
        last = now;
        draw();
        requestAnimationFrame(frame);
    }

    Promise.all([load('assets/fresco.jpg'), load('assets/arm.png'), load('assets/sleeve.png')])
        .then(([f, a, s]) => {
            fresco = f; arm = a; sleeve = s;
            // no WebGL2: show the undithered painting instead
            if (!setupGL()) vctx = view.getContext('2d');
            resize();
            addEventListener('resize', resize);
            requestAnimationFrame(frame);
            requestAnimationFrame(() => view.classList.add('ready'));
        });
})();
