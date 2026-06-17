// phosphor-featured.ts — static, tree-shaken map of the 36 curated featured glyphs (CTL-1233).
// Named imports (NOT `import *`) so Rollup tree-shakes to just these components → main bundle
// stays near pre-CTL-1226 size. The full ~1,500-icon set loads dynamically (see phosphor-icons.ts).
import {
  GitFork, Rocket, Cube, Stack, Cpu, TerminalWindow, Lightning, Globe, Database, HardDrives,
  Shield, Sparkle, Star, Flame, Leaf, ChartBar, Flask, Bug, Package, Cloud, Gear, Compass,
  Target, Tree, Boat, Mountains, Flower, Hexagon, Diamond, Crown, Robot, Alien, Cat, Dog, Bird, Fish,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

// Keyed by kebab name (matches PHOSPHOR_GLYPH_NAMES in project-glyph-set.ts).
export const FEATURED_ICONS: Readonly<Record<string, Icon>> = {
  "git-fork": GitFork, rocket: Rocket, cube: Cube, stack: Stack, cpu: Cpu,
  "terminal-window": TerminalWindow, lightning: Lightning, globe: Globe, database: Database,
  "hard-drives": HardDrives, shield: Shield, sparkle: Sparkle, star: Star, flame: Flame, leaf: Leaf,
  "chart-bar": ChartBar, flask: Flask, bug: Bug, package: Package, cloud: Cloud, gear: Gear,
  compass: Compass, target: Target, tree: Tree, boat: Boat, mountains: Mountains, flower: Flower,
  hexagon: Hexagon, diamond: Diamond, crown: Crown, robot: Robot, alien: Alien, cat: Cat, dog: Dog,
  bird: Bird, fish: Fish,
};
