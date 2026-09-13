/**
 * Mnemosyne's interactive brand sculpture. This is a conceptual visualization,
 * never a view of a customer's memories or an account migration.
 * Three.js is pinned and served locally; see vendor/three/SOURCE.md.
 */
const root = document.getElementById('memory-scene');

if (root) {
  const canvas = document.getElementById('memory-canvas');
  const stage = document.getElementById('scene-stage');
  const status = document.getElementById('scene-status');
  const help = document.getElementById('scene-help');
  const pauseButton = document.getElementById('scene-pause');
  const resetButton = document.getElementById('scene-reset');
  const modeLabel = document.getElementById('scene-mode-label');
  const modeDetail = document.getElementById('scene-mode-detail');
  const modeButtons = [...root.querySelectorAll('[data-scene-mode]')];
  const controls = [...modeButtons, pauseButton, resetButton].filter(Boolean);
  let release = () => {};
  let startupTimer = 0;
  let failed = false;

  const fallback = () => {
    failed = true;
    window.clearTimeout(startupTimer);
    release();
    // A lost context must not leave keyboard focus on an invisible canvas or
    // a control that is about to become disabled.
    if (document.activeElement === canvas || controls.includes(document.activeElement)) {
      const focusTarget = status || modeLabel;
      if (focusTarget) {
        const previousTabIndex = focusTarget.getAttribute('tabindex');
        focusTarget.tabIndex = -1;
        focusTarget.focus({ preventScroll: true });
        focusTarget.addEventListener('blur', () => {
          if (previousTabIndex === null) focusTarget.removeAttribute('tabindex');
          else focusTarget.setAttribute('tabindex', previousTabIndex);
        }, { once: true });
      }
    }
    root.classList.remove('scene-ready');
    root.dataset.sceneState = 'fallback';
    stage?.setAttribute('aria-busy', 'false');
    if (status) status.textContent = 'Memory contour · interactive 3D unavailable';
    if (help) help.textContent = 'The memory concept is shown above. Explore the product below.';
    if (modeLabel) modeLabel.textContent = 'Memory, in a new dimension';
    if (modeDetail) modeDetail.textContent = 'A conceptual sculpture of connected memory. The product and recorded demos remain available below.';
    controls.forEach((control) => { control.disabled = true; });
    if (canvas) {
      canvas.tabIndex = -1;
      canvas.setAttribute('aria-hidden', 'true');
    }
  };

  const start = async () => {
    if (!(canvas instanceof HTMLCanvasElement) || !stage) return fallback();
    controls.forEach((control) => { control.disabled = true; });
    root.dataset.sceneState = 'loading';
    stage.setAttribute('aria-busy', 'true');
    if (status) status.textContent = 'Preparing interactive 3D…';
    const THREE = await Promise.race([
      import('./vendor/three/three.module.min.js'),
      new Promise((_, reject) => {
        // Keep a complete native contour visible while loading. The deadline
        // covers the first rendered frame, including deferred or failed setup.
        startupTimer = window.setTimeout(() => {
          fallback();
          reject(new Error('3D startup timed out'));
        }, 12000);
      }),
    ]);
    if (failed) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listeners = new AbortController();
    const signal = listeners.signal;
    const geometries = new Set();
    const materials = new Set();
    const instancedMeshes = new Set();
    const geometry = (value) => { geometries.add(value); return value; };
    const material = (value) => { materials.add(value); return value; };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
    let renderer;
    let environment;
    let resizeObserver;
    let intersectionObserver;
    let frame = 0;
    let disposed = false;
    let inView = true;
    let manuallyPaused = false;
    let globalPaused = document.documentElement.dataset.motion === 'paused';
    let lastFrame = 0;
    let elapsed = 0;
    let ready = false;

    // Dispose GPU allocations and listeners on failure or final navigation.
    release = () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(startupTimer);
      cancelAnimationFrame(frame);
      frame = 0;
      listeners.abort();
      reducedMotion.removeEventListener('change', handleMotion);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      instancedMeshes.forEach((value) => value.dispose());
      geometries.forEach((value) => value.dispose());
      materials.forEach((value) => value.dispose());
      environment?.dispose();
      renderer?.dispose();
    };

    renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: 'low-power',
      stencil: false, preserveDrawingBuffer: false,
    });
    renderer.setClearColor(0x060a12, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.transmissionResolutionScale = 0.5;
    renderer.debug.onShaderError = () => {
      throw new Error('The device could not compile the sculpture shaders');
    };

    // A tiny generated studio environment gives the metal meaningful reflections
    // without fetching an HDR file or adding a postprocessing pipeline.
    const studio = new THREE.Scene();
    const roomGeometry = new THREE.BoxGeometry(24, 20, 24);
    const roomMaterial = new THREE.MeshBasicMaterial({ color: 0x101b2b, side: THREE.BackSide });
    studio.add(new THREE.Mesh(roomGeometry, roomMaterial));
    const lightGeometry = new THREE.PlaneGeometry(1, 1);
    const studioMaterials = [];
    [
      { color: 0xddeaff, intensity: 5, position: [-5, 6, 4], scale: [5, 10] },
      { color: 0x4a8fff, intensity: 4, position: [6, 3, -3], scale: [3, 9] },
      { color: 0xb5ffff, intensity: 3, position: [0, 7, -4], scale: [10, 3] },
      { color: 0xffffff, intensity: 3, position: [0, 0, 8], scale: [2, 10] },
    ].forEach((panel) => {
      const panelMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(panel.color).multiplyScalar(panel.intensity), side: THREE.DoubleSide,
      });
      studioMaterials.push(panelMaterial);
      const light = new THREE.Mesh(lightGeometry, panelMaterial);
      light.position.set(...panel.position);
      light.scale.set(panel.scale[0], panel.scale[1], 1);
      light.lookAt(0, 0, 0);
      studio.add(light);
    });
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      environment = pmrem.fromScene(studio, 0.03, 0.1, 50);
      scene.environment = environment.texture;
      scene.environmentIntensity = 1.2;
    } finally {
      pmrem.dispose();
      roomGeometry.dispose();
      roomMaterial.dispose();
      lightGeometry.dispose();
      studioMaterials.forEach((value) => value.dispose());
    }

    scene.add(new THREE.HemisphereLight(0xd1ecff, 0x08111e, 2.1));
    const keyLight = new THREE.DirectionalLight(0xe3f5ff, 4.5);
    keyLight.position.set(-3, 5, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x2b7fff, 5);
    rimLight.position.set(5, 1, -4);
    scene.add(rimLight);
    const coreLight = new THREE.PointLight(0x49dfff, 11, 8, 2);
    coreLight.position.set(0, 0.2, 0.8);
    scene.add(coreLight);

    const sculpture = new THREE.Group();
    scene.add(sculpture);
    const body = new THREE.Group();
    sculpture.add(body);

    // One beveled arch is instanced 54 times: 27 discrete metal lamellae per
    // side. Their central legs meet to make the Mnemosyne double arch.
    const arch = new THREE.Shape();
    const radius = 1.04;
    const innerRadius = 0.76;
    const leg = 1.62;
    arch.moveTo(-radius, -leg);
    arch.lineTo(-radius, 0);
    arch.absarc(0, 0, radius, Math.PI, 0, true);
    arch.lineTo(radius, -leg);
    arch.lineTo(innerRadius, -leg);
    arch.lineTo(innerRadius, 0);
    arch.absarc(0, 0, innerRadius, 0, Math.PI, false);
    arch.lineTo(-innerRadius, -leg);
    arch.closePath();
    const archGeometry = geometry(new THREE.ExtrudeGeometry(arch, {
      depth: 0.026, steps: 1, curveSegments: 30,
      bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2,
    }));
    const metal = material(new THREE.MeshPhysicalMaterial({
      color: 0xb0c4dc, metalness: 0.94, roughness: 0.23,
      clearcoat: 0.75, clearcoatRoughness: 0.2, envMapIntensity: 1.15,
    }));
    const layerCount = 27;
    const plates = new THREE.InstancedMesh(archGeometry, metal, layerCount * 2);
    instancedMeshes.add(plates);
    plates.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Expanded layers intentionally exceed the initial instanced bounds.
    plates.frustumCulled = false;
    body.add(plates);
    const instanceColor = new THREE.Color();
    for (let index = 0; index < layerCount * 2; index += 1) {
      const layer = index % layerCount;
      instanceColor.set(layer % 9 === 4 ? 0x518dc7 : layer % 3 === 0 ? 0xe2ecf7 : 0xa3bbd9);
      plates.setColorAt(index, instanceColor);
    }
    const coreMaterial = material(new THREE.MeshStandardMaterial({
      color: 0x37cfff, emissive: 0x1389ed, emissiveIntensity: 2.1,
      metalness: 0.45, roughness: 0.28,
    }));
    const cores = [];
    const glass = material(new THREE.MeshPhysicalMaterial({
      color: 0xc5deea, metalness: 0.58, roughness: 0.11, transmission: 0.16,
      thickness: 0.12, ior: 1.4, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1,
    }));
    const glassSkins = [];
    [-1, 1].forEach((side) => {
      const core = new THREE.Mesh(archGeometry, coreMaterial);
      core.position.set(side * 0.925, 0.47, 0.04);
      core.scale.z = 2.6;
      body.add(core);
      cores.push(core);
      const skin = new THREE.Mesh(archGeometry, glass);
      skin.position.set(side * 0.925, 0.47, 0.8);
      skin.rotation.y = side * 0.035;
      body.add(skin);
      glassSkins.push(skin);
    });

    const evidence = new THREE.Group();
    sculpture.add(evidence);
    const nodeGeometry = geometry(new THREE.IcosahedronGeometry(0.055, 1));
    const nodeMaterial = material(new THREE.MeshStandardMaterial({
      color: 0xb0f3ff, emissive: 0x35b5f5, emissiveIntensity: 2.2,
      metalness: 0.45, roughness: 0.16,
    }));
    const nodes = [];
    const nodeCoordinates = [
      [-2.8, 1.55, 0.7], [2.72, 1.1, -0.6], [2.95, -0.48, 0.65],
      [-2.6, -0.92, -0.55], [-1.65, 2.03, -1.05], [1.33, 2.3, 0.05],
      [0.6, -1.64, 1.54], [-1.3, -1.7, 1.4],
    ];
    nodeCoordinates.forEach((coordinates, index) => {
      const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
      node.position.set(...coordinates);
      node.scale.setScalar(index % 3 === 0 ? 1.35 : 1);
      evidence.add(node);
      nodes.push(node);
    });
    const connectionArray = new Float32Array(nodes.length * 12);
    const connectionGeometry = geometry(new THREE.BufferGeometry());
    connectionGeometry.setAttribute('position', new THREE.BufferAttribute(connectionArray, 3).setUsage(THREE.DynamicDrawUsage));
    const connectionMaterial = material(new THREE.LineBasicMaterial({
      color: 0x50b9ec, transparent: true, opacity: 0.14, depthWrite: false,
    }));
    const connections = new THREE.LineSegments(connectionGeometry, connectionMaterial);
    connections.frustumCulled = false;
    evidence.add(connections);

    // Thin geometric orbits are restrained reference lines, not a particle cloud.
    const orbitMaterial = material(new THREE.LineBasicMaterial({
      color: 0x377cab, transparent: true, opacity: 0.19, depthWrite: false,
    }));
    [0, 1].forEach((index) => {
      const points = [];
      for (let step = 0; step < 128; step += 1) {
        const angle = (step / 128) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * 3.16, Math.sin(angle) * 2.08, 0));
      }
      const orbit = new THREE.LineLoop(geometry(new THREE.BufferGeometry().setFromPoints(points)), orbitMaterial);
      orbit.rotation.set(index === 0 ? 1.2 : 0.32, index === 0 ? 0.25 : 0.68, index === 0 ? -0.18 : -0.56);
      orbit.position.y = index === 0 ? -0.6 : 0.15;
      evidence.add(orbit);
    });

    const modeDefinitions = {
      unified: { label: 'Unified memory', detail: 'One continuous structure. Rotate the layers to explore the architecture.', spread: 0.062, separate: 0, reveal: 0 },
      linked: { label: 'Evidence, connected', detail: 'Follow the connections between memory and its sources. A concept of traceable knowledge.', spread: 0.082, separate: 0.07, reveal: 0.58 },
      expanded: { label: 'Every layer, inspectable', detail: 'Open the structure. Distinct layers stay connected as the view expands.', spread: 0.115, separate: 0.16, reveal: 1 },
    };
    let mode = 'unified';
    const current = { ...modeDefinitions[mode] };
    let target = modeDefinitions[mode];
    let transition = false;
    let drag = null;
    let yaw = -0.39;
    let pitch = 0.07;
    let pointerX = 0;
    let pointerY = 0;
    let parallaxX = 0;
    let parallaxY = 0;
    const transform = new THREE.Object3D();
    const paused = () => manuallyPaused || globalPaused || reducedMotion.matches;
    const visible = () => inView && !document.hidden && !disposed;

    function updateControls() {
      const externallyPaused = globalPaused || reducedMotion.matches;
      if (pauseButton) {
        pauseButton.disabled = !ready || externallyPaused;
        pauseButton.textContent = externallyPaused ? 'Scene paused' : manuallyPaused ? 'Resume scene' : 'Pause scene';
        pauseButton.setAttribute('aria-pressed', String(paused()));
        pauseButton.title = reducedMotion.matches ? 'Reduced motion follows your device preference' : globalPaused ? 'Use the page motion control to resume' : '';
      }
      if (status && ready) status.textContent = paused() ? 'Interactive 3D · motion paused' : 'Interactive 3D · drag to explore';
      root.dataset.sceneMotion = paused() ? 'paused' : 'playing';
    }

    function updateGeometry(immediate = false) {
      const ease = immediate ? 1 : 0.11;
      let distance = 0;
      ['spread', 'separate', 'reveal'].forEach((key) => {
        current[key] += (target[key] - current[key]) * ease;
        distance += Math.abs(target[key] - current[key]);
      });
      transition = distance > 0.0005;
      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const side = sideIndex === 0 ? -1 : 1;
        for (let layer = 0; layer < layerCount; layer += 1) {
          const centered = layer - (layerCount - 1) / 2;
          const fan = centered / ((layerCount - 1) / 2);
          transform.position.set(
            side * (0.925 + current.separate) + fan * current.reveal * 0.055,
            0.47 + Math.abs(fan) * current.reveal * 0.12,
            centered * current.spread,
          );
          transform.rotation.set(0, fan * current.reveal * 0.014, side * fan * current.reveal * 0.012);
          transform.updateMatrix();
          plates.setMatrixAt(sideIndex * layerCount + layer, transform.matrix);
        }
        cores[sideIndex].position.x = side * (0.925 + current.separate);
        glassSkins[sideIndex].position.x = side * (0.925 + current.separate);
        glassSkins[sideIndex].position.z = 13 * current.spread + 0.075;
      }
      plates.instanceMatrix.needsUpdate = true;
      connectionMaterial.opacity = 0.095 + current.reveal * 0.29;
      orbitMaterial.opacity = 0.15 + current.reveal * 0.1;
    }

    function updateEvidence() {
      nodes.forEach((node, index) => {
        const base = nodeCoordinates[index];
        const expansion = 1 + current.reveal * 0.04;
        node.position.set(
          base[0] * expansion,
          base[1] + Math.sin(elapsed * 0.32 + index) * 0.065,
          base[2] + Math.cos(elapsed * 0.24 + index) * 0.07,
        );
        const offset = index * 12;
        connectionArray.set([node.position.x, node.position.y, node.position.z,
          index % 2 === 0 ? -1.02 : 1.02, index < 6 ? 0.72 : -0.65, (index % 3 - 1) * 0.65,
          node.position.x, node.position.y, node.position.z,
          nodes[(index + 1) % nodes.length].position.x, nodes[(index + 1) % nodes.length].position.y, nodes[(index + 1) % nodes.length].position.z], offset);
      });
      connectionGeometry.attributes.position.needsUpdate = true;
    }

    function draw(now = 0) {
      frame = 0;
      if (disposed || document.hidden || (ready && !inView)) return;
      const delta = Math.min((now - lastFrame) / 1000 || 0, 0.05);
      lastFrame = now;
      if (!paused()) elapsed += delta;
      if (transition) updateGeometry(paused());
      const parallaxEase = paused() ? 1 : 0.065;
      parallaxX += (pointerX - parallaxX) * parallaxEase;
      parallaxY += (pointerY - parallaxY) * parallaxEase;
      sculpture.rotation.set(pitch + parallaxY * 0.09, yaw + parallaxX * 0.16 + Math.sin(elapsed * 0.16) * 0.055, -0.025);
      body.position.y = Math.sin(elapsed * 0.38) * 0.035;
      updateEvidence();
      try {
        renderer.render(scene, camera);
        if (renderer.getContext().isContextLost()) throw new Error('3D context unavailable');
        if (!ready) {
          ready = true;
          window.clearTimeout(startupTimer);
          root.classList.add('scene-ready');
          root.dataset.sceneState = 'ready';
          stage.setAttribute('aria-busy', 'false');
          if (help) help.textContent = '↔ Drag to rotate · choose a state';
          controls.forEach((control) => { control.disabled = false; });
          canvas.tabIndex = 0;
          canvas.removeAttribute('aria-hidden');
          canvas.style.touchAction = 'pan-y pinch-zoom';
          canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home');
          updateControls();
        }
      } catch {
        fallback();
        return;
      }
      // No continuous work while paused, off-screen, or in a hidden tab.
      if (!paused() || transition) frame = requestAnimationFrame(draw);
    }

    function requestDraw() {
      // Render once even below the fold, then retain normal off-screen suspension.
      if (!frame && (visible() || (!ready && !document.hidden && !disposed))) {
        lastFrame = performance.now();
        frame = requestAnimationFrame(draw);
      }
    }

    function handleMotion() {
      if (paused()) {
        cancelAnimationFrame(frame);
        frame = 0;
        updateGeometry(true);
        pointerX = 0;
        pointerY = 0;
      }
      updateControls();
      requestDraw();
    }

    function setMode(nextMode, immediate) {
      if (!Object.hasOwn(modeDefinitions, nextMode)) return;
      mode = nextMode;
      target = modeDefinitions[mode];
      transition = true;
      root.dataset.sceneMode = mode;
      modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sceneMode === mode)));
      if (modeLabel) modeLabel.textContent = target.label;
      if (modeDetail) modeDetail.textContent = target.detail;
      if (immediate || paused()) updateGeometry(true);
      requestDraw();
    }

    function reset() {
      yaw = -0.39;
      pitch = 0.07;
      pointerX = pointerY = parallaxX = parallaxY = 0;
      elapsed = 0;
      setMode('unified', true);
    }

    modeButtons.forEach((button) => button.addEventListener('click', (event) => {
      setMode(button.dataset.sceneMode, event.detail === 0);
    }, { signal }));
    pauseButton?.addEventListener('click', () => {
      manuallyPaused = !manuallyPaused;
      handleMotion();
    }, { signal });
    resetButton?.addEventListener('click', reset, { signal });
    reducedMotion.addEventListener('change', handleMotion);
    window.addEventListener('mnemosyne:motionchange', (event) => {
      globalPaused = typeof event.detail?.paused === 'boolean'
        ? event.detail.paused : document.documentElement.dataset.motion === 'paused';
      handleMotion();
    }, { signal });
    canvas.addEventListener('keydown', (event) => {
      const step = 0.14;
      if (event.key === 'ArrowLeft') yaw -= step;
      else if (event.key === 'ArrowRight') yaw += step;
      else if (event.key === 'ArrowUp') pitch = Math.max(-0.4, pitch - step);
      else if (event.key === 'ArrowDown') pitch = Math.min(0.5, pitch + step);
      else if (event.key === 'Home') reset();
      else return;
      event.preventDefault();
      requestDraw();
    }, { signal });

    canvas.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, horizontal: event.pointerType !== 'touch' };
      if (drag.horizontal) canvas.setPointerCapture(event.pointerId);
    }, { signal });
    canvas.addEventListener('pointermove', (event) => {
      if (!event.isPrimary) return;
      if (drag?.id === event.pointerId) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.horizontal) {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
          if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
          drag.horizontal = true;
          canvas.setPointerCapture(event.pointerId);
        }
        yaw += (event.clientX - drag.lastX) * 0.006;
        drag.lastX = event.clientX;
        requestDraw();
      } else if (event.pointerType === 'mouse' && !paused()) {
        const bounds = canvas.getBoundingClientRect();
        pointerX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
        pointerY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
        requestDraw();
      }
    }, { signal });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag, { signal });
    canvas.addEventListener('pointercancel', endDrag, { signal });
    canvas.addEventListener('lostpointercapture', endDrag, { signal });
    canvas.addEventListener('pointerleave', () => {
      pointerX = pointerY = 0;
      requestDraw();
    }, { signal });

    function resize() {
      if (disposed) return;
      const width = Math.max(1, stage.clientWidth);
      const height = Math.max(1, stage.clientHeight);
      const narrow = window.innerWidth < 700;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 1.75));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.position.set(0, 0.9, Math.max(8.7, 8.0 / Math.max(camera.aspect, 0.7)));
      camera.lookAt(0, 0.1, 0);
      camera.updateProjectionMatrix();
      requestDraw();
    }
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(stage);
    }
    window.addEventListener('resize', resize, { signal, passive: true });
    if ('IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        if (inView || !ready) requestDraw();
        else { cancelAnimationFrame(frame); frame = 0; }
      }, { rootMargin: '40px', threshold: 0 });
      intersectionObserver.observe(stage);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else requestDraw();
    }, { signal });
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      fallback();
    }, { signal });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) release();
      else { cancelAnimationFrame(frame); frame = 0; }
    }, { signal });
    window.addEventListener('pageshow', requestDraw, { signal });
    setMode('unified', true);
    resize();
  };

  start().catch(fallback);
}
