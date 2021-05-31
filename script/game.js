import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.118/build/three.module.js';
import {GLTFLoader} from 'https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/GLTFLoader.js';

// TODO: Use prebuilt lobby
import * as lobby from 'https://flackr.github.io/lobby/src/lobby.mjs';

const DEFAULT_MATRIX_HOST = 'https://matrix.org';

let service;
let client;
let game;
let canvas;
let scale = 1;

const KEY_W = 'W'.charCodeAt(0);
const KEY_S = 'S'.charCodeAt(0);;
const KEY_A = 'A'.charCodeAt(0);;
const KEY_D = 'D'.charCodeAt(0);;
const KEY_ENTER = 13;
const KEY_SPACE = 32;


const ARENA_WIDTH = 10000;
const ARENA_HEIGHT = 8000;
const UPDATE_RATE = 0.001 / 60;

let center = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];

const SHOT_RADIUS = 3;

const TANK_WIDTH = 25;
const TANK_HEIGHT = 30;
const TANK_FIRE_INTERVAL = 1000;
window.TANK_FRICTION = 0.2;
window.TANK_ACCELERATION = 120000;
window.TANK_TURN_RATE = 0.6;
window.DEADZONE = 0.5;
window.SHOT_VELOCITY = 120;

// Adapted from https://www.cs.rit.edu/~ncs/color/t_convert.html
function hsvToRgb(h, s, v) {
  let r, g, b;
  if(s == 0) {
    r = g = b = v;
    return [r, g, b];
  }

  h /= 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
   
  switch(i) {
      case 0:
          r = v;
          g = t;
          b = p;
          break;
   
      case 1:
          r = q;
          g = v;
          b = p;
          break;
   
      case 2:
          r = p;
          g = v;
          b = t;
          break;
   
      case 3:
          r = p;
          g = q;
          b = v;
          break;
   
      case 4:
          r = t;
          g = p;
          b = v;
          break;
   
      default:
          r = v;
          g = p;
          b = q;
  }
   
  return [r, g, b];
}

const SHOT_DIST = TANK_HEIGHT / 2 + SHOT_RADIUS;
function hitTestShot(shot, tank) {
  let dx = tank.x - shot.x;
  let dy = tank.y - shot.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  // TODO: Accurate hit detection between a circle and a rotated rectangle.
  if (d >= SHOT_DIST)
    return false;

  // Detect if shot is going towards or away from tank.
  // Use dot product of direction to tank vector and shot.
  dx = dx / d;
  dy = dy / d;
  let dotproduct = dx * (shot.dx / SHOT_VELOCITY) + dy * (shot.dy / SHOT_VELOCITY);
  return dotproduct > 0;
}

/**
 * Tanks will be a map from user id to:
 * {
 *    x: X coordinate
 *    y: Y coordinate
 *    r: rotation
 *    dx: X velocity
 *    dy: Y velocity
 *    dr: rotational velocity
 * }
 * Players will contain a map to player info
 * {
 *    name: player name
 *    ping: ping
 * }
 */
let tanks = {};
let projectiles = [];

let keys = {};
let touchController;

class Game {
  constructor() {
    this._initialize();
  }

  async _initialize() {
    this._threejs = new THREE.WebGLRenderer({
      antialias: true,
    });
    this._threejs.outputEncoding = THREE.sRGBEncoding;
    this._threejs.shadowMap.enabled = true;
    this._threejs.shadowMap.type = THREE.PCFSoftShadowMap;
    this._threejs.setPixelRatio(window.devicePixelRatio);
    this._threejs.setSize(window.innerWidth, window.innerHeight);

    document.body.appendChild(this._threejs.domElement);

    document.body.addEventListener('keydown', this._keyHandler);
    document.body.addEventListener('touchstart', this._bodyTouchHandler);
    touchController = document.getElementById('touchcontroller');
    touchController.addEventListener('touchstart', this._touchHandler);
    touchController.addEventListener('touchmove', this._touchHandler);
    touchController.addEventListener('touchend', this._touchHandler);
    document.body.addEventListener('keyup', this._keyHandler);

    window.addEventListener('resize', () => {
      this._OnWindowResize();
    }, false);
    const fov = 60;
    const aspect = 1920 / 1080;
    const near = 1.0;
    const far = 5000.0;
    this._camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    this._camera.position.set(0, 200, 125);
    this._camera.lookAt(new THREE.Vector3(0, 0, 0));

    this._scene = new THREE.Scene();

    let light = new THREE.DirectionalLight(0xFFFFFF, 1.0);
    light.position.set(-100, 100, 100);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.bias = -0.001;
    light.shadow.mapSize.width = 4096;
    light.shadow.mapSize.height = 4096;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 500.0;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = 500.0;
    light.shadow.camera.left = 150;
    light.shadow.camera.right = -150;
    light.shadow.camera.top = 150;
    light.shadow.camera.bottom = -150;
    this._scene.add(light);

    light = new THREE.AmbientLight(0xFFFFFF, 0.25);
    this._scene.add(light);

    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(800, 600, 10, 10),
        new THREE.MeshStandardMaterial({
            color: 0x808080,
          }));
    plane.castShadow = false;
    plane.receiveShadow = true;
    plane.rotation.x = -Math.PI / 2;
    this._scene.add(plane);

    this._mixers = [];
    this._previousRAF = null;

    this._OnWindowResize();
    this._RAF();

    service = await lobby.createService({
      appName: 'com.github.flackr.lobby.Test',
      defaultHost: DEFAULT_MATRIX_HOST,
    });
    window.service = service;
    // TODO: Handle failure.
    client = await service.ensureLogin(document.getElementById('login'), 'show');
    let room = window.location.search.substring(1);
    if (!room) {
      room = await client.create();
      history.replaceState(null, '', '?' + room);
    }
    game = await client.join(room, true, {stateless: true});
    game.addEventListener('event', this._handleMessage);
    game.addEventListener('disconnection', (evt) => {
      let model = tanks[evt.client_id].model;
      if (model)
        this._scene.remove(model);
      delete tanks[evt.client_id];
    });
    game.addEventListener('reset', this._reset);
    document.body.focus();
    this._tankCount = 0;
  }

  _reset = () => {
    tanks = {};
    projectiles = [];
  }

  _bodyTouchHandler = (evt) => {
    document.body.classList.add('touch');
    evt.preventDefault();
    if (evt.target == touchController)
      return;
    this._createTankOrFire();
  };
  
  _touchHandler = (evt) => {
    // TODO: don't simulate keys.
    let deadzone = (touchController.offsetWidth / 2) * 0.3;
    delete keys[KEY_W];
    delete keys[KEY_A];
    delete keys[KEY_D];
    delete keys[KEY_S];
    if (evt.type == 'touchmove' || evt.type == 'touchstart') {
      let pos = evt.touches[0];
      let rel = [
        pos.clientX - touchController.offsetLeft - touchController.offsetWidth / 2,
        pos.clientY - touchController.offsetTop - touchController.offsetHeight / 2,
      ];
      if (rel[0] < - deadzone)
        keys[KEY_A] = true;
      else if (rel[0] > deadzone)
        keys[KEY_D] = true;
      if (rel[1] < -deadzone)
        keys[KEY_W] = true;
      else if (rel[1] > deadzone)
        keys[KEY_S] = true;
    }
    evt.preventDefault();
  };
  
  _keyHandler = (evt) => {
    if (evt.target != document.body)
      return;
    document.body.classList.remove('touch');
    if (evt.type == 'keydown') {
      if (evt.keyCode == KEY_SPACE || evt.keyCode == KEY_ENTER) {
        this._createTankOrFire();
      }
      keys[evt.keyCode] = true;
    } else if (evt.type == 'keyup') {
      delete keys[evt.keyCode];
    }
    let heldKeys = [];
    for (let keycode in keys) {
      heldKeys.push(keycode);
    }
    evt.preventDefault();
  };

  _createTankOrFire = () => {
    if (!game)
      return;
    let tank = tanks[game.client_id];
    if (!tank || !tank.data.alive) {
      game.send({type: 'create'});
      return;
    }
    
    // Fire!
    let now = performance.now();
    if (tank.lastFired !== null && now - tank.lastFired < TANK_FIRE_INTERVAL)
      return;
  
    tank.lastFired = now;
    let dir = [Math.sin(tank.data.r), -Math.cos(tank.data.r)];
    let offset = TANK_HEIGHT / 2;
    let shot = {
      x: tank.data.x + dir[0] * offset,
      y: tank.data.y + dir[1] * offset,
      dx: dir[0] * SHOT_VELOCITY,
      dy: dir[1] * SHOT_VELOCITY,
    };
    // TODO: Shots shouldn't technically be ephemeral but since we don't have
    // a timestamp on them we don't want them being created late.
    game.send({type: 'fire', shot}, {ephemeral: 'direct'});
  };

  _handleMessage = async (evt) => {
    if (evt.detail.type == 'create') {
      if (!tanks[evt.client_id]) {
        tanks[evt.client_id] = {
          data: {},
          lastFired: null,
          model: null,
        };
      }
      tanks[evt.client_id].data = {
        x: 0,
        y: 0,
        r: 0,
        dx: 0,
        dy: 0,
        dr: 0,
        alive: true,
      };
      
      if (!tanks[evt.client_id].model) {
        let color = hsvToRgb(((this._tankCount++) * 40) % 360, 1, 0.6);
        // TODO: This should not load another model but clone an already loaded instance.
        tanks[evt.client_id].model = await this._loadModel(color);
      }
    } else if (evt.detail.type == 'update' && evt.client_id != game.client_id) {
      tanks[evt.client_id].data = evt.detail.loc;
    } else if (evt.detail.type == 'fire') {
      // TODO: Add a model for the projectiles.
      projectiles.push(evt.detail.shot);
      const geometry = new THREE.SphereGeometry( SHOT_RADIUS, 16, 16 );
      const material = new THREE.MeshBasicMaterial( {color: 0xffff00} );
      const sphere = new THREE.Mesh( geometry, material );
      projectiles[projectiles.length - 1].model = sphere;
      this._scene.add( sphere );
    }
  }  

  _loadModel(color) {
    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load('./resources/tank.glb', (gltf) => {
        gltf.scene.traverse(c => {
          if (c.material && c.material.name == 'Tank Surface') {
            c.material.color.r = color[0];
            c.material.color.g = color[1];
            c.material.color.b = color[2];
          }
          c.castShadow = true;
          c.receiveShadow = true;
        });
        gltf.scene.scale.set(2, 2, 2);
        const mixer = new THREE.AnimationMixer(gltf.scene);
        //gltf.animations.forEach((clip) => {mixer.clipAction(clip).play(); });
        this._mixers.push(mixer);
        this._scene.add(gltf.scene);
        resolve(gltf.scene);
      });  
    });
  }

  _OnWindowResize() {
    this._camera.aspect = window.innerWidth / window.innerHeight;
    this._camera.updateProjectionMatrix();
    this._threejs.setSize(window.innerWidth, window.innerHeight);
  }

  _RAF() {
    requestAnimationFrame((t) => {
      if (this._previousRAF === null) {
        this._previousRAF = t;
      }
      this._RAF();
      let dt = (t - this._previousRAF) * 0.001;
      let updates = Math.round(dt / UPDATE_RATE);

      if (game) {
        for (let tankid in tanks) {
          let obj = tanks[tankid];
          let tank = obj.data;
          if (tank.alive) {
            for (let i = 0; i < updates; ++i) {
              tank.x += tank.dx * UPDATE_RATE;
              tank.y += tank.dy * UPDATE_RATE;
              tank.r += tank.dr * UPDATE_RATE;
              tank.dx *= (1 - TANK_FRICTION);
              if (Math.abs(tank.dx) < DEADZONE)
                tank.dx = 0;
              tank.dy *= (1 - TANK_FRICTION);
              if (Math.abs(tank.dy) < DEADZONE)
                tank.dy = 0;    
            }
          }
          let model = obj.model;
          if (model) {
            model.position.set(tank.x, 0, tank.y);
            model.rotation.set(0, -tank.r + Math.PI / 2, 0);
          }
        }

        for (let i = 0; i < projectiles.length; ++i) {
          projectiles[i].x += projectiles[i].dx * dt;
          projectiles[i].y += projectiles[i].dy * dt;
          projectiles[i].model.position.set(projectiles[i].x, 10, projectiles[i].y);
          let remove = projectiles[i].x < -ARENA_WIDTH || projectiles[i].x > ARENA_WIDTH ||
                       projectiles[i].y < -ARENA_HEIGHT || projectiles[i].y > ARENA_HEIGHT;
          for (let tankid in tanks) {
            let tank = tanks[tankid];
            if (hitTestShot(projectiles[i], tank.data)) {
              tank.data.alive = false;
              remove = true;
              break;
            }
          }
          if (remove) {
            this._scene.remove(projectiles[i].model);
            projectiles.splice(i--, 1);
          }
        }      

        // Send an update to the network about our tank.
        let tank = tanks[game.client_id] && tanks[game.client_id].data;
        if (tank && tank.alive) {
          let invert = keys[KEY_S] ? -1 : 1;
          let steer = 0;
          if (keys[KEY_A])
            steer = -TANK_TURN_RATE * dt;
          if (keys[KEY_D])
            steer = TANK_TURN_RATE * dt;
          tank.r += steer * invert;
          if (keys[KEY_W] || keys[KEY_S]) {
            let multiplier = (keys[KEY_W] ? 1 : 0) + (keys[KEY_S] ? -0.6 : 0);
            tank.dx += Math.sin(tank.r) * TANK_ACCELERATION * multiplier * dt;
            tank.dy -= Math.cos(tank.r) * TANK_ACCELERATION * multiplier * dt;
          }
          game.send({type: 'update', loc: tank}, {ephemeral: 'direct'});
        }
      }

      this._threejs.render(this._scene, this._camera);
      this._Step(t - this._previousRAF);
      this._previousRAF = t;
    });
  }

  _Step(timeElapsed) {
    const timeElapsedS = timeElapsed * 0.001;
    if (this._mixers) {
      this._mixers.map(m => m.update(timeElapsedS));
    }

  }
};

let _APP = null;

window.addEventListener('DOMContentLoaded', () => {
  _APP = new Game();
});
