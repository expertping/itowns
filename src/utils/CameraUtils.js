import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import DEMUtils from './DEMUtils';
import { MAIN_LOOP_EVENTS } from '../Core/MainLoop';
import Coordinates from '../Core/Geographic/Coordinates';

THREE.Object3D.DefaultUp.set(0, 0, 1);
const targetPosition = new THREE.Vector3();
const rigs = [];
const slerp = [];

const deferred = () => {
    let resolve;
    return { promise: new Promise((r) => { resolve = r; }), resolve };
};

// Wrap angle in degrees to [-180 180]
function wrapTo180(angle) {
    return angle - Math.floor((angle + 179.0) / 360) * 360;
}

function tileLayer(view) {
    return view.getLayers(l => l.protocol == 'tile')[0];
}

// fix coord.altitude < 0 and !pickedPosition (with plane and ellipsoid intersection)
function getGroundTargetFromCamera(view, camera, target) {
    camera.updateMatrixWorld(true);
    // FIXME view.wgs84TileLayer
    const pickedPosition = view.wgs84TileLayer ? view.getPickingPositionFromDepth() : undefined;
    const range = pickedPosition && !isNaN(pickedPosition.x) ? camera.position.distanceTo(pickedPosition) : 100;
    camera.localToWorld(target.set(0, 0, -range));
}

function proxyProperty(view, camera, rig, key) {
    rig.proxy.position[key] = camera.position[key];
    Object.defineProperty(camera.position, key, {
        get: () => rig.proxy.position[key],
        set: (newValue) => {
            rig.removeProxy(view, camera);
            camera.position[key] = newValue;
        },
    });
}

// the rig is used to manipulate the camera
// It consists of a tree of 3D objects, each element is assigned a task
//
//                      Transformation
//
// rig                  position on Coordinate  (for the globe is rotation)
// |
// └── sealevel         position on altitude zero
//     |
//     └── target       position on DEM, and rotation (pitch and heading)
//         |
//         └── camera   distance to target
//
// When all transformations are calculated,
// this.camera's transformation is applied to view.camera.camera
class CameraRig extends THREE.Object3D {
    constructor() {
        super();
        // seaLevel is on rig's z axis, it's at altitude zero
        this.seaLevel = new THREE.Object3D();
        // target is on seaLevel's z axis and target.position.z is the DEM altitude
        this.target = new THREE.Object3D();
        this.target.rotation.order = 'ZXY';
        // camera look at target
        this.camera = new THREE.Camera();
        this.add(this.seaLevel);
        this.seaLevel.add(this.target);
        this.target.add(this.camera);
        this.coord = new Coordinates('EPSG:4978', 0, 0);
    }

    // apply rig.camera's transformation to camera
    applyTransformToCamera(view, camera) {
        if (this.proxy) {
            camera.quaternion.onChange(() => {});
            this.camera.matrixWorld.decompose(this.proxy.position, camera.quaternion, camera.scale);
            camera.quaternion.onChange(() => this.removeProxy(view, camera));
        } else {
            this.camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
        }
    }

    setProxy(view, camera) {
        if (!this.proxy && view && camera) {
            this.proxy = { position: new THREE.Vector3() };
            Object.keys(camera.position).forEach(key => proxyProperty(view, camera, this, key));
            camera.quaternion.onChange(() => this.removeProxy(view, camera));
        }
    }

    removeProxy(view, camera) {
        this.stop(view);
        if (this.proxy && view && camera) {
            Object.keys(camera.position).forEach(key => Object.defineProperty(camera.position, key, { value: this.proxy.position[key], writable: true }));
            this.quaternion.onChange(() => {});
            this.proxy = null;
        }
    }

    setTargetFromCoordinate(view, coord) {
        // clamp altitude to seaLevel
        coord.as(tileLayer(view).extent.crs(), this.coord);
        const altitude = Math.max(0, this.coord._values[2]);
        this.coord._values[2] = altitude;
        // adjust target's position with clamped altitude
        this.coord.as(view.referenceCrs).xyz(targetPosition);
        if (view.referenceCrs == 'EPSG:4978') {
            // ellipsoid geocentric projection
            this.lookAt(targetPosition);
            this.seaLevel.position.set(0, 0, targetPosition.length() - altitude);
        } else {
            // planar projection
            this.position.set(targetPosition.x, targetPosition.y, 0);
            this.seaLevel.position.set(0, 0, 0);
        }
        // place camera's target
        this.target.position.set(0, 0, altitude);
    }

    // set rig's objects transformation from camera's position and target's position
    setFromPositions(view, cameraPosition, targetPosition) {
        this.setTargetFromCoordinate(view, new Coordinates(view.referenceCrs, targetPosition));
        this.target.rotation.set(0, 0, 0);
        this.updateMatrixWorld(true);
        this.camera.position.copy(cameraPosition);
        this.target.worldToLocal(this.camera.position);
        const range = this.camera.position.length();
        this.target.rotation.x = Math.asin(this.camera.position.z / range);
        const cosPlanXY = THREE.Math.clamp(this.camera.position.y / (Math.cos(this.target.rotation.x) * range), -1, 1);
        this.target.rotation.z = Math.sign(-this.camera.position.x) * Math.acos(cosPlanXY);
        this.camera.position.set(0, range, 0);
    }

    // set from target's coordinate, rotation and range between target and camera
    applyParams(view, params) {
        if (params.coord) {
            this.setTargetFromCoordinate(view, params.coord);
        }
        if (params.tilt != undefined) {
            this.target.rotation.x = THREE.Math.degToRad(params.tilt);
        }
        if (params.heading != undefined) {
            this.target.rotation.z = THREE.Math.degToRad(wrapTo180(params.heading + 180));
        }
        if (params.range) {
            this.camera.position.set(0, params.range, 0);
        }
        this.camera.rotation.set(-Math.PI * 0.5, 0, Math.PI);
        this.updateMatrixWorld(true);
    }

    getParams() {
        return {
            coord: this.coord.clone(),
            tilt: this.tilt,
            heading: this.heading,
            range: this.range,
        };
    }

    setfromCamera(view, camera) {
        getGroundTargetFromCamera(view, camera, targetPosition);
        this.setFromPositions(view, camera.position, targetPosition);
    }

    copyObject3D(rig) {
        this.copy(rig, false);
        this.seaLevel.copy(rig.seaLevel, false);
        this.target.copy(rig.target, false);
        this.camera.copy(rig.camera);
        return this;
    }

    animateCameraToLookAtTarget(view, camera, params) {
        this.setfromCamera(view, camera);
        const tweenGroup = new TWEEN.Group();
        this.start = (this.start || new CameraRig()).copyObject3D(this);
        this.end = (this.end || new CameraRig()).copyObject3D(this);
        const time = params.time || 2500;
        const factor = { t: 0 };
        const animations = [];
        this.deferred = deferred();

        this.addPlaceTargetOnGround(view, camera, params.coord, factor);
        this.end.applyParams(view, params);

        animations.push(new TWEEN.Tween(factor, tweenGroup).to({ t: 1 }, time)
            .easing(TWEEN.Easing.Quartic.InOut)
            .onUpdate((d) => {
                // rotate to coord destination in geocentric projection
                if (view.referenceCrs == 'EPSG:4978') {
                    THREE.Quaternion.slerpFlat(slerp, 0, this.start.quaternion.toArray(), 0, this.end.quaternion.toArray(), 0, d.t);
                    this.quaternion.fromArray(slerp);
                }
                // camera rotation
                THREE.Quaternion.slerpFlat(slerp, 0, this.start.camera.quaternion.toArray(), 0, this.end.camera.quaternion.toArray(), 0, d.t);
                this.camera.quaternion.fromArray(slerp);
                // camera's target rotation
                this.target.rotation.set(0, 0, 0);
                this.target.rotateZ(THREE.Math.lerp(this.start.target.rotation.z, this.end.target.rotation.z, d.t));
                this.target.rotateX(THREE.Math.lerp(this.start.target.rotation.x, this.end.target.rotation.x, d.t));
            }));

        // translate to coordinate destination in planar projection
        if (view.referenceCrs != 'EPSG:4978') {
            animations.push(new TWEEN.Tween(this.position, tweenGroup)
            .to(this.end.position, time)
            .easing(TWEEN.Easing.Quartic.InOut));
        }

        // translate to altitude zero
        animations.push(new TWEEN.Tween(this.seaLevel.position, tweenGroup)
            .to(this.end.seaLevel.position, time)
            .easing(TWEEN.Easing.Quartic.InOut));

        // translate camera position
        animations.push(new TWEEN.Tween(this.camera.position, tweenGroup)
            .to(this.end.camera.position, time)
            .easing(TWEEN.Easing.Quartic.InOut));

        // update animations, transformation and view
        const worldPosition = new THREE.Vector3();
        const newCoord = new Coordinates(view.referenceCrs, worldPosition);
        const animationFrameRequester = () => {
            tweenGroup.update();
            this.updateMatrixWorld(true);
            this.applyTransformToCamera(view, camera);
            worldPosition.setFromMatrixPosition(this.seaLevel.matrixWorld);
            newCoord.set(view.referenceCrs, worldPosition).as(tileLayer(view).extent.crs(), this.coord);
            view.notifyChange(camera);
        };

        function removeAll() {
            tweenGroup.removeAll();
            view.removeFrameRequester(MAIN_LOOP_EVENTS.BEFORE_RENDER, animationFrameRequester);
        }

        animations[0].onComplete(this.deferred.resolve);
        animations[0].onStop(this.deferred.resolve);
        animations.forEach(anim => anim.start());

        view.addFrameRequester(MAIN_LOOP_EVENTS.BEFORE_RENDER, animationFrameRequester);
        view.notifyChange(camera);

        this.deferred.promise.then(() => removeAll());

        return this.deferred;
    }

    stop(view) {
        if (view && this.placeTargetOnGround) {
            view.removeFrameRequester(MAIN_LOOP_EVENTS.BEFORE_RENDER, this.placeTargetOnGround);
            this.placeTargetOnGround = null;
        }
        if (this.deferred) {
            this.deferred.resolve();
            return this.deferred.promise;
        } else {
            return Promise.resolve();
        }
    }

    // update target position to coordinate's altitude
    addPlaceTargetOnGround(view, camera, coord, options = { t: 1.0 }) {
        if (view && camera) {
            const startAltitude = this.target.position.z;
            this.placeTargetOnGround = () => {
                const result = DEMUtils.getElevationValueAt(tileLayer(view), coord || this.coord, DEMUtils.PRECISE_READ_Z);
                const altitude = Math.max(0, result ? result.z : 0);
                this.target.position.z = startAltitude * (1.0 - options.t) + altitude * options.t;
                this.target.updateMatrixWorld(true);
                this.applyTransformToCamera(view, camera);
            };
            this.placeTargetOnGround();
            view.addFrameRequester(MAIN_LOOP_EVENTS.BEFORE_RENDER, this.placeTargetOnGround);
        }
    }

    get tilt() { return THREE.Math.radToDeg(this.target.rotation.x); }

    get heading() { return wrapTo180((THREE.Math.radToDeg(this.target.rotation.z) + 180)); }

    get range() { return this.camera.position.y; }
}

function getRig(camera) {
    rigs[camera.uuid] = rigs[camera.uuid] || new CameraRig(camera);
    return rigs[camera.uuid];
}

/**
 * @typedef {Object} cameraTransformOptions
 * @property {Coordinate} [coordinate=currentCoordinate] Camera look at coordinate
 * @property {Number} [tilt=currentTilt] camera's tilt, in degree
 * @property {Number} [heading=currentHeading] camera's heading, in degree
 * @property {Number} [range=currentRange] camera distance to target coordinate, in meter
 * @property {Number} [time=2500] duration of the animation, in ms
 * @property {boolean} [proxy=true] use proxy to handling camera's transformation. if proxy == true, other transformation stops rig's transformation
 */
/**
 * @module CameraUtils
 */
export default {
    /**
     * Stop camera's animation
     *
     * @param      {View}  view    The camera view
     * @param      {Camera}  camera  The camera to stop animation
     */
    stop(view, camera) {
        getRig(camera).stop(view);
    },
    /**
     * Gets the current parameters transform camera looking at target.
     *
     * @param      {View}  view    The camera view
     * @param      {Camera}  camera  The camera to get transform
     * @return     {cameraTransformOptions}  The transform camera looking at target
     */
    getTransformCameraLookingAtTarget(view, camera) {
        const rig = getRig(camera);
        rig.setfromCamera(view, camera);
        return rig.getParams();
    },
    /**
     * Apply transform to camera
     *
     * @param      {View}  view    The camera view
     * @param      {Camera}  camera  The camera to transform
     * @param      {cameraTransformOptions}  params  The parameters
     * @return     {Promise} promise
     */
    transformCameraToLookAtTarget(view, camera, params = {}) {
        params.proxy = params.proxy === undefined || params.proxy;
        const rig = getRig(camera);
        return rig.stop(view).then(() => {
            rig.setfromCamera(view, camera);
            if (params.proxy) {
                rig.setProxy(view, camera);
            }
            rig.applyParams(view, params);
            rig.addPlaceTargetOnGround(view, camera, params.coord);
            rig.applyTransformToCamera(view, camera);
            view.notifyChange(camera);
            return Promise.resolve(rig.getParams());
        });
    },
    /**
     * Apply transform to camera with animation
     *
     * @param      {View}  view    The camera view
     * @param      {Camera}  camera  The camera to animate
     * @param      {cameraTransformOptions}  params  The parameters
     * @return     {Promise} promise
     */
    animateCameraToLookAtTarget(view, camera, params = {}) {
        params.proxy = params.proxy === undefined || params.proxy;
        const rig = getRig(camera);
        return rig.stop(view).then(() => {
            if (params.proxy) {
                rig.setProxy(view, camera);
            }
            return rig.animateCameraToLookAtTarget(view, camera, params).promise.then(() => rig.getParams());
        });
    },

    getDiffParams(previous, newP) {
        let diff;
        if (Math.abs(previous.range - newP.range) / previous.range > 0.001) {
            diff = diff || {};
            diff.range = {
                previous: previous.range,
                new: newP.range,
            };
        }
        if (Math.abs(previous.tilt - newP.tilt) > 0.1) {
            diff = diff || {};
            diff.tilt = {
                previous: previous.tilt,
                new: newP.tilt,
            };
        }
        if (Math.abs(previous.heading - newP.heading) > 0.1) {
            diff = diff || {};
            diff.heading = {
                previous: previous.heading,
                new: newP.heading,
            };
        }

        if (Math.abs(previous.coord._values[0] - newP.coord._values[0]) > 0.1 ||
            Math.abs(previous.coord._values[1] - newP.coord._values[1] > 0.1)) {
            diff = diff || {};
            diff.coord = {
                previous: previous.coord,
                new: newP.coord,
            };
        }
        return diff;
    },
};

// TODO
// * problem si coord.altitude > 0 dans les parametres car la target est réellement position à cette altitude
// * lock altitude problème car il reste locker obliger de faire une stopAnimations
// * add support with intersect ellipsoid
// add stop animation in key pan

