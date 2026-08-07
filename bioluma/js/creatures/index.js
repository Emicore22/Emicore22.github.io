import krill from './krill.js';
import fish from './fish.js';
import octopus from './octopus.js';
import jelly from './jelly.js';
import squid from './squid.js';
import ray from './ray.js';
import siphon from './siphon.js';
import anemone from './anemone.js';

/* Order is the order of the picker in the panel: swarms first, then the
   single-animal drivers, then the two that make compositions rather than
   crowds. */
export const CREATURES = [krill, fish, octopus, jelly, squid, ray, siphon, anemone];

export const creatureById = (id) => CREATURES.find((c) => c.id === id) || CREATURES[0];
