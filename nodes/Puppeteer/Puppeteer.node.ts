import {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from "n8n-workflow";
import { makeResolverFromLegacyOptions } from "@n8n/vm2";
import {
	// Browser,
	Device,
	KnownDevices as devices,
	Page,
	// PaperFormat,
	// PDFOptions,
	// PuppeteerLifeCycleEvent,
	// ScreenshotOptions,
} from "puppeteer";
// import puppeteer from "puppeteer-extra";
// import pluginStealth from "puppeteer-extra-plugin-stealth";
import { nodeDescription } from "./Puppeteer.node.options";
import { ipcRequest } from "./puppeteer/helpers";
import server from "./puppeteer";

const {
	NODE_FUNCTION_ALLOW_BUILTIN: builtIn,
	NODE_FUNCTION_ALLOW_EXTERNAL: external,
	// CODE_ENABLE_STDOUT,
} = process.env;

export const vmResolver = makeResolverFromLegacyOptions({
	external: external
		? {
				modules: external.split(","),
				transitive: false,
		  }
		: false,
	builtin: builtIn?.split(",") ?? [],
});

// we start the server if we are in the main process
if (!process.send) server();

interface HeaderObject {
	parameter: Record<string, string>[];
}

type ErrorResponse = INodeExecutionData & {
	json: {
		error: string;
		url?: string;
		headers?: HeaderObject;
		statusCode?: number;
		body?: string;
	};
	pairedItem: {
		item: number;
	};
	[key: string]: unknown;
	error: Error;
};

export async function handleError(
	this: IExecuteFunctions,
	error: Error,
	itemIndex: number,
	url?: string,
	page?: Page
): Promise<INodeExecutionData[]> {
	if (page) {
		try {
			await page.close();
		} catch (closeError) {
			console.error("Error closing page:", closeError);
		}
	}

	if (this.continueOnFail()) {
		const nodeOperationError = new NodeOperationError(this.getNode(), error.message);

		const errorResponse: ErrorResponse = {
			json: {
				error: error.message,
			},
			pairedItem: {
				item: itemIndex,
			},
			error: nodeOperationError,
		};

		if (url) {
			errorResponse.json.url = url;
		}

		return [errorResponse];
	}

	throw new NodeOperationError(this.getNode(), error.message);
}

export class Puppeteer implements INodeType {
	description: INodeTypeDescription = nodeDescription;

	methods = {
		loadOptions: {
			async getDevices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const deviceNames = Object.keys(devices);
				const returnData: INodePropertyOptions[] = [];

				for (const name of deviceNames) {
					const device = devices[name as keyof typeof devices] as Device;
					returnData.push({
						name,
						value: name,
						description: `${device.viewport.width} x ${device.viewport.height} @ ${device.viewport.deviceScaleFactor}x`,
					});
				}

				return returnData;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		let returnData: INodeExecutionData[] = [];
		const credentials = (await this.getCredentials("n8nApi")) as {
			apiKey: string;
			baseUrl: string;
		};
		// @ts-ignore
		const executionId = this.getExecutionId();

		const globalOptions = this.getNodeParameter("globalOptions", 0, {}) as IDataObject;

		const nodeOptions = this.getNodeParameter("nodeOptions", 0, {}) as IDataObject;

		const url = this.getNodeParameter("url", 0, {}) as string;

		const queryParameters = this.getNodeParameter("queryParameters", 0, {}) as IDataObject;

		const interactions = this.getNodeParameter("interactions", 0, {}) as IDataObject;

		const output = this.getNodeParameter("output", 0, {}) as IDataObject;

		const isStarted = await ipcRequest("launch", {
			globalOptions,
			executionId,
		}).catch((e: any) => {
			throw new Error(e);
		});

		if (isStarted) {
			console.log("exec", globalOptions);
			const res = await ipcRequest("exec", {
				nodeParameters: {
					globalOptions,
					nodeOptions,
					url,
					queryParameters,
					interactions,
					output,
				},
				executionId,
				continueOnFail: this.continueOnFail(),
			}).catch((e: any) => {
				throw new Error(e);
			});

			if (res) {
				if (res.binary) {
					for await (const key of Object.keys(res.binary)) {
						const type = res.binary[key].type;
						const binaryData = await this.helpers
							.prepareBinaryData(Buffer.from(res.binary[key].data), undefined, type === "pdf" ? "application/pdf" : `image/${res.binary[key].type}`)
							.catch((e) => console.log(e));
						if (binaryData) res.binary[key] = binaryData;
						else delete res.binary[key];
					}
				}

				returnData = [res];
			}
		}

		ipcRequest("check", {
			executionId,
			apiKey: credentials.apiKey,
			baseUrl: credentials.baseUrl,
		});

		return this.prepareOutputData(returnData);
	}
}
