import * as coda from "@codahq/packs-sdk";
import { extendSchema, getPackId, formatItem, getMetdataSettings, getVersions, getFiles, handleError, getCategories, unformatItem, removeCategory, addCategory } from "./helpers";
import { MetadataTypes, PackUrlRegexes } from "./constants";
import { MyPackSchema, PackSchema } from "./schemas";
const escape = require('escape-html');

export const pack = coda.newPack();

const PackIdOrUrlParameter = coda.makeParameter({
  type: coda.ParameterType.String,
  name: "packIdOrUrl",
  description: "The ID or URL of the Pack.",
});

pack.addNetworkDomain("coda.io");
pack.addNetworkDomain("coda-us-west-2-prod-packs.s3.us-west-2.amazonaws.com");

pack.setUserAuthentication({
  type: coda.AuthenticationType.CodaApiHeaderBearerToken,
  shouldAutoAuthSetup: true,
  networkDomain: "coda.io",
});

pack.addFormula({
  name: "Pack",
  description: "Load information about a Pack",
  parameters: [
    PackIdOrUrlParameter,
  ],
  resultType: coda.ValueType.Object,
  schema: extendSchema(Object.keys(MetadataTypes)),
  execute: async function (args, context) {
    let [packIdOrUrl] = args;
    let packId = getPackId(context, packIdOrUrl);
    let baseUrl = coda.joinUrl(context.invocationLocation.protocolAndHost, "apis/v1/packs/listings");
    let url = coda.withQueryParams(baseUrl, {
      packIds: packId
    });
    let response = await context.fetcher.fetch({
      method: "GET",
      url: url,
    });
    let { items } = response.body;
    if (!items?.length) {
      throw new coda.UserVisibleError(`Pack not found: ${packIdOrUrl}`);
    }
    let item = items[0];
    formatItem(context, item);
    let jobs = [];
    let metadata = Object.keys(MetadataTypes);
    for (let key of metadata) {
      let settings = getMetdataSettings(key);
      jobs.push(settings.callback(context, items));
    }
    await Promise.allSettled(jobs);
    return item;
  },
});

pack.addColumnFormat({
  name: "Pack",
  instructions: "Enter the ID or URL of a Pack.",
  formulaName: "Pack",
  matchers: PackUrlRegexes,
});

pack.addSyncTable({
  name: "Packs",
  description: "Lists of all of the Packs you have access to.",
  identityName: "Pack",
  schema: PackSchema,
  dynamicOptions: {
    getSchema: async function (context, search, args) {
      let metadata = args.metdata ?? [];
      return extendSchema(metadata);
    },
    propertyOptions: async function (context) {
      switch (context.propertyName) {
        case "categories":
          return await getCategories(context);
        default:
          throw new coda.UserVisibleError(`Unknown property: ${context.propertyName}`);
      }
    },
  },
  formula: {
    name: "SyncPacks",
    description: "Sync the Packs.",
    parameters: [
      coda.makeParameter({
        type: coda.ParameterType.Boolean,
        name: "includePublished",
        description: "Include public Packs published in the gallery.",
        suggestedValue: true,
      }),
      coda.makeParameter({
        type: coda.ParameterType.Boolean,
        name: "includeWorkspace",
        description: "Include internal Packs shared with everyone in your workspace.",
        suggestedValue: false,
      }),
      coda.makeParameter({
        type: coda.ParameterType.Boolean,
        name: "includePrivate",
        description: "Include private Packs you created or were shared with your directly.",
        suggestedValue: false,
      }),
      coda.makeParameter({
        type: coda.ParameterType.StringArray,
        name: "metdata",
        description: "Which additional Pack metadata to include (may increase time to sync).",
        optional: true,
        autocomplete: Object.entries(MetadataTypes).map(([key, value]) => ({
          display: value.name, value: key,
        })),
      }),
    ],
    execute: async function (args, context) {
      let [
        includePublished,
        includeWorkspace,
        includePrivate,
        metadata = [],
      ] = args;
      let url = context.sync.continuation?.url as string;
      if (!url) {
        let baseUrl = coda.joinUrl(context.invocationLocation.protocolAndHost, "apis/v1/packs/listings");
        url = coda.withQueryParams(baseUrl, {
          excludePublicPacks: !includePublished,
          excludeWorkspaceAcls: !includeWorkspace,
          excludeIndividualAcls: !includePrivate,
          limit: 20,
        });
      }
      let response = await context.fetcher.fetch({
        method: "GET",
        url: url,
      });
      let { items, nextPageLink } = response.body;
      for (let item of items) {
        formatItem(context, item);
      }
      let jobs = [];
      for (let key of metadata) {
        let settings = getMetdataSettings(key);
        jobs.push(settings.callback(context, items));
      }
      await Promise.allSettled(jobs);
      let continuation;
      if (nextPageLink) {
        continuation = { url: nextPageLink };
      }
      return {
        result: items,
        continuation,
      };
    },
  },
});

pack.addSyncTable({
  name: "MyPacks",
  description: "Lists the Packs that you can edit. Only includes basic information about each Pack.",
  identityName: "MyPack",
  schema: MyPackSchema,
  dynamicOptions: {
    entityName: "Pack",
    propertyOptions: async function (context) {
      switch (context.propertyName) {
        case "categories":
          return await getCategories(context);
        default:
          throw new coda.UserVisibleError(`Unknown property: ${context.propertyName}`);
      }
    },
  },
  formula: {
    name: "SyncMyPacks",
    description: "Sync the MyPacks.",
    parameters: [],
    execute: async function (args, context) {
      let url = context.sync.continuation?.url as string;
      if (!url) {
        let baseUrl = coda.joinUrl(context.invocationLocation.protocolAndHost, "apis/v1/packs");
        url = coda.withQueryParams(baseUrl, {
          accessTypes: "edit,admin",
          limit: 20,
        });
      }
      let response = await context.fetcher.fetch({
        method: "GET",
        url: url,
      });
      let { items, nextPageLink } = response.body;
      for (let item of items) {
        formatItem(context, item);
      }
      let continuation;
      if (nextPageLink) {
        continuation = { url: nextPageLink };
      }
      return {
        result: items,
        continuation,
      };
    },
    executeUpdate: async function (args, updates, context) {
      let host = context.invocationLocation.protocolAndHost;
      let update = updates[0];
      let pack = update.newValue;

      if (update.updatedFields.includes("categories")) {
        let jobs = [];
        for (let category of update.previousValue.categories) {
          if (!update.newValue.categories.includes(category)) {
            jobs.push(removeCategory(context, pack.packId, category));
          }
        }
        for (let category of update.newValue.categories) {
          if (!update.previousValue.categories.includes(category)) {
            jobs.push(addCategory(context, pack.packId, category));
          }
        }
        await Promise.all(jobs);
      }

      unformatItem(pack);
      let body = Object.fromEntries(
        Object.entries(update.newValue).filter(
          ([key, value]) => update.updatedFields.includes(key)));
      let response = await context.fetcher.fetch({
        method: "PATCH",
        url: coda.joinUrl(host, "apis/v1/packs", String(pack.packId)),
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      let final = response.body;
      formatItem(context, final);
      return {
        result: [final],
      };
    },
  },
});

pack.addFormula({
  name: "SourceCode",
  description: "Gets the source code for a Pack. You must be a Pack Admin of the Pack.",
  parameters: [
    PackIdOrUrlParameter,
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "version",
      description: "Which version of the Pack to get the source code for.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  codaType: coda.ValueHintType.Html,
  onError: handleError,
  execute: async function (args, context) {
    let [packIdOrUrl, version] = args;
    let packId = getPackId(context, packIdOrUrl);
    if (!version) {
      let versions = await getVersions(context, packId);
      version = versions[0].packVersion;
    }
    let files = await getFiles(context, packId, version);
    if (!files?.length) {
      throw new Error(`No source code found.`);
    }
    let file = files[0];
    let response = await context.fetcher.fetch({
      method: "GET",
      url: file.url,
      disableAuthentication: true,
    });
    let code = response.body;
    return `<pre>${escape(code)}</pre>`;
  },
});
