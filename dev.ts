#!/usr/bin/env -S deno run -A --watch=static/,routes/
import { dirname, fromFileUrl, join, toFileUrl } from "std/path/mod.ts";
import "std/dotenv/load.ts";
import { collect } from "$fresh/src/dev/mod.ts";
import { walk } from "std/fs/walk.ts";
import {
  COMPONENT_NAME_REGEX,
  componentNameFromPath,
} from "./utils/component.ts";

interface DevManifest {
  routes: string[];
  islands: string[];
  components: string[];
  schemas: SchemaMap[];
}

export async function dev(
  base: string,
  entrypoint: string,
  onListen?: () => void,
) {
  entrypoint = new URL(entrypoint, base).href;

  const dir = dirname(fromFileUrl(base));

  let currentManifest: DevManifest;
  const prevManifest = Deno.env.get("FRSH_DEV_PREVIOUS_MANIFEST");
  if (prevManifest) {
    currentManifest = JSON.parse(prevManifest);
  } else {
    currentManifest = { islands: [], routes: [], components: [], schemas: [] };
  }
  const newManifest: DevManifest = await collect(dir) as DevManifest;
  newManifest.components = await collectComponents(dir);
  Deno.env.set("FRSH_DEV_PREVIOUS_MANIFEST", JSON.stringify(newManifest));
  newManifest.schemas = await collectComponentsSchemas(
    newManifest.islands,
    newManifest.components,
    dir,
  );

  const manifestChanged =
    !arraysEqual(newManifest.routes, currentManifest.routes) ||
    !arraysEqual(newManifest.islands, currentManifest.islands) ||
    !arraysEqual(newManifest.components, currentManifest.components);

  if (manifestChanged) await generate(dir, newManifest);

  if (onListen) onListen();

  await import(entrypoint);
}

interface SchemaMap {
  component: string;
  schema: Record<string, any>;
}

// This only handles islands and components at rootPath.
// Ex: ./islands/Foo.tsx or ./components/Bar.tsx .
// This ./components/My/Nested/Component.tsx won't work
async function collectComponentsSchemas(
  islands: string[],
  components: string[],
  directory: string,
): Promise<SchemaMap[]> {
  // Islands has precedence over components
  const islandComponents = new Set<string>([...islands]);

  const mapComponentToSchemaMap = async (
    componentName: string,
    type: "islands" | "components",
  ) => {
    const componentModule = await import(
      toFileUrl(
        join(directory, type, componentName),
      ).href
    );

    const schema = componentModule.schema;

    if (!schema) {
      return;
    }

    return {
      component: componentNameFromPath(componentName),
      schema,
    };
  };

  const componentSchemasPromises: Promise<SchemaMap | undefined>[] = [];
  islands.forEach((islandName) => {
    componentSchemasPromises.push(
      mapComponentToSchemaMap(islandName, "islands"),
    );
  });

  components.forEach((componentName) => {
    if (
      islandComponents.has(componentName)
    ) {
      return;
    }

    componentSchemasPromises.push(
      mapComponentToSchemaMap(componentName, "components"),
    );
  });

  const componentsSchemas = await Promise.all(componentSchemasPromises);

  return componentsSchemas.filter((value): value is SchemaMap =>
    Boolean(value)
  );
}

export async function generate(directory: string, manifest: DevManifest) {
  const { routes, islands, components, schemas } = manifest;

  const output = `// DO NOT EDIT. This file is generated by deco.
    // This file SHOULD be checked into source version control.
    // This file is automatically updated during development when running \`dev.ts\`.

    import config from "./deno.json" assert { type: "json" };
    import { DecoManifest } from "$live/types.ts";
    ${routes.map(templates.routes.imports).join("\n")}
    ${islands.map(templates.islands.imports).join("\n")}
    ${components.map(templates.components.imports).join("\n")}

    const manifest: DecoManifest = {
      routes: {${routes.map(templates.routes.obj).join("\n")}},
      islands: {${islands.map(templates.islands.obj).join("\n")}},
      components: {${components.map(templates.components.obj).join("\n")}},
      schemas: {${schemas.map(templates.schemas).join("\n")}},
      baseUrl: import.meta.url,
      config,
    };

    export default manifest;
    `;

  const manifestStr = await format(output);
  const manifestPath = join(directory, "./deco.gen.ts");

  await Deno.writeTextFile(manifestPath, manifestStr);
  console.log(
    `%cThe manifest has been generated for ${routes.length} routes, ${islands.length} islands and ${components.length} components.`,
    "color: green; font-weight: bold",
  );
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function format(content: string) {
  const proc = Deno.run({
    cmd: [Deno.execPath(), "fmt", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });

  const raw = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
  await raw.pipeTo(proc.stdin.writable);
  const out = await proc.output();
  await proc.status();
  proc.close();

  return new TextDecoder().decode(out);
}

async function collectComponents(dir: string): Promise<string[]> {
  const componentsDir = join(dir, "./components");

  const components = [];
  try {
    const componentsUrl = toFileUrl(componentsDir);
    // TODO(lucacasonato): remove the extranious Deno.readDir when
    // https://github.com/denoland/deno_std/issues/1310 is fixed.
    for await (const _ of Deno.readDir(componentsDir)) {
      // do nothing
    }
    const componentsFolder = walk(componentsDir, {
      includeDirs: false,
      includeFiles: true,
      exts: ["tsx", "jsx", "ts", "js"],
    });
    for await (const entry of componentsFolder) {
      if (entry.isFile) {
        const file = toFileUrl(entry.path).href.substring(
          componentsUrl.href.length,
        );
        components.push(file);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Do nothing.
    } else {
      throw err;
    }
  }
  components.sort();

  return components;
}

const templates = {
  routes: {
    imports: (file: string, i: number) =>
      `import * as $${i} from "./routes${file}";`,
    obj: (file: string, i: number) =>
      `${JSON.stringify(`./routes${file}`)}: $${i},`,
  },
  islands: {
    imports: (file: string, i: number) =>
      `import * as $$${i} from "./islands${file}";`,
    obj: (file: string, i: number) =>
      `${JSON.stringify(`./islands${file}`)}: $$${i},`,
  },
  components: {
    imports: (file: string, i: number) =>
      `import * as $$$${i} from "./components${file}";`,
    obj: (file: string, i: number) =>
      `${JSON.stringify(`./components${file}`)}: $$$${i},`,
  },
  schemas: (
    { component, schema }: SchemaMap,
  ) => `"${component}": ${schema ? JSON.stringify(schema) : null},`,
};
