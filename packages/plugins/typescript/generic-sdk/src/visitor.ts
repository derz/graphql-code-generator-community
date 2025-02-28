import autoBind from 'auto-bind';
import { GraphQLSchema, Kind, OperationDefinitionNode, print } from 'graphql';
import {
  ClientSideBasePluginConfig,
  ClientSideBaseVisitor,
  DocumentMode,
  getConfigValue,
  indentMultiline,
  LoadedFragment,
} from '@graphql-codegen/visitor-plugin-common';
import { RawGenericSdkPluginConfig } from './config.js';

export interface GenericSdkPluginConfig extends ClientSideBasePluginConfig {
  usingObservableFrom: string;
  rawRequest: boolean;
}

function isStreamOperation(operationAST: OperationDefinitionNode) {
  if (operationAST.operation === 'subscription') {
    return true;
  }
  if (
    operationAST.operation === 'query' &&
    operationAST.directives?.some(directiveNode => directiveNode.name.value === 'live')
  ) {
    return true;
  }
  return false;
}

export class GenericSdkVisitor extends ClientSideBaseVisitor<
  RawGenericSdkPluginConfig,
  GenericSdkPluginConfig
> {
  private _externalImportPrefix: string;
  private _operationsToInclude: {
    node: OperationDefinitionNode;
    documentVariableName: string;
    operationType: string;
    operationResultType: string;
    operationVariablesTypes: string;
  }[] = [];

  constructor(
    schema: GraphQLSchema,
    fragments: LoadedFragment[],
    rawConfig: RawGenericSdkPluginConfig,
  ) {
    super(schema, fragments, rawConfig, {
      usingObservableFrom: rawConfig.usingObservableFrom,
      rawRequest: getConfigValue(rawConfig.rawRequest, false),
    });

    autoBind(this);

    if (this.config.usingObservableFrom) {
      this._additionalImports.push(this.config.usingObservableFrom);
    }
    const importType = this.config.useTypeImports ? 'import type' : 'import';
    if (this.config.documentMode !== DocumentMode.string) {
      this._additionalImports.push(
        `${importType} { DocumentNode${
          this.config.rawRequest ? ', ExecutionResult' : ''
        } } from 'graphql';`,
      );
    } else if (this.config.rawRequest) {
      this._additionalImports.push(`${importType} { ExecutionResult } from 'graphql';`);
    }

    this._externalImportPrefix = this.config.importOperationTypesFrom
      ? `${this.config.importOperationTypesFrom}.`
      : '';
  }

  protected buildOperation(
    node: OperationDefinitionNode,
    documentVariableName: string,
    operationType: string,
    operationResultType: string,
    operationVariablesTypes: string,
  ): string {
    operationResultType = this._externalImportPrefix + operationResultType;
    operationVariablesTypes = this._externalImportPrefix + operationVariablesTypes;

    if (node.name == null) {
      throw new Error(
        "Plugin 'generic-sdk' cannot generate SDK for unnamed operation.\n\n" + print(node),
      );
    } else {
      this._operationsToInclude.push({
        node,
        documentVariableName,
        operationType,
        operationResultType,
        operationVariablesTypes,
      });
    }

    return null;
  }

  private getDocumentNodeVariable(documentVariableName: string): string {
    return this.config.documentMode === DocumentMode.external
      ? `Operations.${documentVariableName}`
      : documentVariableName;
  }

  public get sdkContent(): string {
    const usingObservable = !!this.config.usingObservableFrom;
    const allPossibleActionsConfig = this._operationsToInclude.map(o => {
      const operationName = o.node.name.value;
      const optionalVariables =
        !o.node.variableDefinitions ||
        o.node.variableDefinitions.length === 0 ||
        o.node.variableDefinitions.every(v => v.type.kind !== Kind.NON_NULL_TYPE || v.defaultValue);
      const docVarName = this.getDocumentNodeVariable(o.documentVariableName);
      const returnType = isStreamOperation(o.node)
        ? usingObservable
          ? 'Observable'
          : 'AsyncIterable'
        : 'Promise';
      const resultData = this.config.rawRequest
        ? `ExecutionResult<${o.operationResultType}, E>`
        : o.operationResultType;

      return {
        operationName,
        optionalVariables,
        operationVariablesTypes: o.operationVariablesTypes,
        operationResultType: o.operationResultType,
        docVarName,
        returnType,
        resultData,
      };
    });

    const allPossibleActions = allPossibleActionsConfig
      .map(o => {
        return `export function ${o.operationName}<C, E>(requester: Requester<C, E>, variables${
          o.optionalVariables ? '?' : ''
        }: ${o.operationVariablesTypes}, options?: C): ${o.returnType}<${o.resultData}> {
  return requester<${o.operationResultType}, ${o.operationVariablesTypes}>(${
          o.docVarName
        }, variables, options) as ${o.returnType}<${o.resultData}>;
}`;
      })
      .map(s => indentMultiline(s, 2));

    const allPossibleActionsImpl = allPossibleActionsConfig.map(o => {
      return `${o.operationName}(variables${o.optionalVariables ? '?' : ''}: ${
        o.operationVariablesTypes
      }, options?: C): ${o.returnType}<${o.resultData}> {
  return ${o.operationName}(requester, variables, options) as ${o.returnType}<${o.resultData}>;
}`;
    });

    const documentNodeType =
      this.config.documentMode === DocumentMode.string ? 'string' : 'DocumentNode';
    const resultData = this.config.rawRequest ? 'ExecutionResult<R, E>' : 'R';
    const returnType = `Promise<${resultData}> | ${
      usingObservable ? 'Observable' : 'AsyncIterable'
    }<${resultData}>`;

    return `
${allPossibleActions.join('\n')}
export type Requester<C = {}, E = unknown> = <R, V>(doc: ${documentNodeType}, vars?: V, options?: C) => ${returnType}
export function getSdk<C, E>(requester: Requester<C, E>) {
  return {
${allPossibleActionsImpl.join(',\n')}
  };
}
export type Sdk = ReturnType<typeof getSdk>;`;
  }
}
