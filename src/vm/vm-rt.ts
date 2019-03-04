import {
    VMParams,
    StepParams,
    GetterProjection,
    ProjectionType,
    InvalidatedRoots,
    Tracked,
    ProjectionMetaData,
    OptimizerFuncNonPredicate,
    SetterProjection,
    ProjectionData
} from "./types";
import {
    call
} from "../../typings";
import {
    Reference
} from './types';

export function packPrimitiveIndex(index: number) {
    return index | 0x1000000;
}

export function unpackPrimitiveIndex(index: number) {
    return index & 0xffffff;
}

export function isPrimitiveIndex(index: number) {
    return index & 0x1000000;
}

export function packProjectionIndex(index: number) {
    return index;
}

type ProjectionResult = any;

interface PublicScope {
    key: ProjectionResult;
    val: ProjectionResult;
    context: ProjectionResult;
    loop: ProjectionResult;
    topLevel: ProjectionResult[];
    root: any;
}

interface RuntimeState {
    $invalidatedRoots: InvalidatedRoots;
    $tracked: Tracked;
}

interface EvalScope {
    args: (string | number)[];
    publicScope: PublicScope;
    runtimeState: RuntimeState;
    conds: {
        [key: number]: number
    };
}

type Evaluator = (scope: EvalScope) => any;
type Resolver = (
    type: any,
    args: Evaluator[],
    index: number,
    metaData: Partial < ProjectionMetaData >
) => Evaluator;

export function buildVM({
    $projectionData,
    $funcLib,
    $funcLibRaw,
    library,
    $res
}: VMParams) {
    const {
        getters,
        primitives,
        topLevels,
        metaData,
        setters
    } = $projectionData;
    const {
        setOnArray
    } = library;
    const primitiveEvaluator = (value: any) => () => value;
    const resolveArgRef = (ref: number): Evaluator =>
        isPrimitiveIndex(ref) ?
        primitiveEvaluator(primitives[unpackPrimitiveIndex(ref)]) :
        (scope: EvalScope) => evaluators[ref](scope);

    const scopeResolver = (key: string, args: Evaluator[], index: number) => (
        scope: EvalScope
    ) => scope.publicScope[key as keyof PublicScope];
    const predicateFunction = (ev: Evaluator, outerScope: EvalScope) => (
            $tracked: Tracked,
            key: ProjectionResult,
            val: ProjectionResult,
            context: ProjectionResult,
            loop: ProjectionResult
        ) =>
        ev({
            ...outerScope,
            runtimeState: {
                ...outerScope.runtimeState,
                $tracked
            },
            publicScope: {
                ...outerScope.publicScope,
                key,
                val,
                context,
                loop
            }
        });

    const topLevelResolver = (type: string, args: Evaluator[], index: number) => (
        scope: EvalScope
    ) => {
        const tracked = scope.runtimeState.$tracked;
        return library[type as "map"](
            tracked,
            index,
            predicateFunction(args[0], scope),
            args[1](scope),
            args[2] ? args[2](scope) : null,
            true
        );
    };

    const topLevelNonPredicate = (
        type: string,
        args: Evaluator[],
        index: number
    ) => {
        debugger
        const func = library[
            type as keyof typeof library
        ] as OptimizerFuncNonPredicate;
        return (scope: EvalScope) =>
            func(scope.runtimeState.$tracked, args[0](scope), index);
    };
    const range = (
        type: string,
        [end, start, step]: Evaluator[],
        index: number,
        metaData: Partial<ProjectionMetaData>
    ) => {
        debugger
        const func = library[
            type as keyof typeof library
        ] as OptimizerFuncNonPredicate;
        const invalidates = !!metaData.invalidates
        return (scope: EvalScope) =>
            library.range(scope.runtimeState.$tracked, end(scope), start(scope), step(scope), index, invalidates)
    };

    const assignOrDefaults = (
        type: string,
        args: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        const func = library.assignOrDefaults;
        const isAssign = type === "assign";
        return (scope: EvalScope) =>
            func(
                scope.runtimeState.$tracked,
                index,
                args[0](scope),
                isAssign,
                !!metaData.invalidates
            );
    };

    const keysOrValues = (
        type: string,
        args: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        const func = library.valuesOrKeysForObject;
        const isValues = type === "values";
        return (scope: EvalScope) =>
            func(
                scope.runtimeState.$tracked,
                index,
                args[0](scope),
                isValues,
                !!metaData.invalidates
            );
    };

    type StringFunc = (...args: any[]) => any;

    const nativeStringResolver = (
            func: StringFunc,
            self: Evaluator,
            args: Evaluator[]
        ) => (evalScope: EvalScope) =>
        func.apply(self(evalScope) as string, args.map(a => a(evalScope)));

    const stringResolver = (type: string, args: Evaluator[], index: number) =>
        nativeStringResolver(
            String.prototype[type as keyof string] as StringFunc,
            args[0],
            args.slice(1)
        );

    // TODO: invalidates
    const call = (type: "call" | "effect", args: Evaluator[], index: number) => (
            evalScope: EvalScope
        ) =>
        library.call(
            evalScope.runtimeState.$tracked,
            args.map(a => a(evalScope)),
            index,
            args.length,
            true
        );

    const bind = (
        type: "bind",
        args: Evaluator[],
        index: number,
        md: Partial < ProjectionMetaData >
    ) => {
        const len = args.length;
        return (evalScope: EvalScope) =>
            library.bind(
                evalScope.runtimeState.$tracked,
                args.map(a => a(evalScope)),
                index,
                args.length,
                !!md.invalidates
            );
    };

    const simpleResolver = (func: (...args: any[]) => any) => (
        type: string,
        args: Evaluator[],
        index: number
    ) => (scope: EvalScope) => func(...args.map(a => a(scope)));

    const wrapCond = (test: Evaluator, index: number, tracked: boolean) =>
        tracked ?
        (scope: EvalScope) => (scope.conds[index] = index) && test(scope) :
        test;

    const ternary = (
        name: "ternary",
        [test, then, alt]: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        const tracked = !!metaData.tracked;
        const thenWrapped = wrapCond(then, 2, tracked);
        const altWrapped = wrapCond(alt, 3, tracked);
        return (scope: EvalScope) =>
            test(scope) ? thenWrapped(scope) : altWrapped(scope);
    };

    const or = (
        name: "or",
        args: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        const tracked = !!metaData.tracked;
        const wrappedArgs = args.map((e, index) => wrapCond(e, index + 1, tracked));
        return (scope: EvalScope) =>
            wrappedArgs.reduce(
                (current: any, next: Evaluator) => current || next(scope),
                false
            );
    };

    const and = (
        name: "and",
        args: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        const tracked = !!metaData.tracked;
        const wrappedArgs = args.map((e, index) => wrapCond(e, index + 1, tracked));
        return (scope: EvalScope) =>
            wrappedArgs.reduce(
                (current: any, next: Evaluator) => current && next(scope),
                true
            );
    };

    const array = (
            name: "array",
            args: Evaluator[],
            index: number,
            metaData: Partial < ProjectionMetaData >
        ) => (scope: EvalScope) =>
        library.array(
            scope.runtimeState.$tracked,
            args.map(a => a(scope)),
            index,
            args.length,
            !!metaData.invalidates
        );

    const object = (
        name: "object",
        args: Evaluator[],
        index: number,
        metaData: Partial < ProjectionMetaData >
    ) => {
        debugger
        const keys: Evaluator[] = [];
        const values: Evaluator[] = [];
        args.forEach((a, i) => {
            if (i % 2) {
                values.push(args[i]);
            } else {
                keys.push(args[i]);
            }
        });
        return (scope: EvalScope) =>
            library.object(
                scope.runtimeState.$tracked,
                values.map(a => a(scope)),
                index,
                keys.map(a => a(scope)),
                !!metaData.invalidates
            );
    };

    const recur = (
            name: "recur",
            [key, loop]: Evaluator[],
            index: number,
            metaData: Partial < ProjectionMetaData >
        ) => (scope: EvalScope) =>
        key(scope).recursiveSteps(loop(scope), scope.runtimeState.$tracked);

    const argResolver = (name: string) => {
        const argMatch = name.match(/arg(\d)/);
        const index = argMatch ? +argMatch[1] : 0;
        return (scope: EvalScope) => scope.args[index];
    };

    const cond = (num: number) => (scope: EvalScope) => scope.conds[num]

    const trace = (name: "trace", args: Evaluator[]) => {
        const getLabel = args.length === 2 ? args[1] : null;
        const getValue = args.length === 2 ? args[1] : args[0];

        return (evalScope: EvalScope) => {
            const value = getValue(evalScope);
            console.log(getLabel ? getLabel(evalScope) + ", " : "", value);
            return value;
        }
    }

    const breakpoint = (name: 'breakpoint', [getValue]: Evaluator[]) =>
        (evalScope: EvalScope) => {
            const value = getValue(evalScope)
            debugger
            return value
        }

    const errorResolver = (name: string) => {
        throw new TypeError(`Invalid verb: ${name}`)
    }


const resolvers: Partial < {
    [key in ProjectionType]: Resolver
} > = {
    val: scopeResolver,
    key: scopeResolver,
    context: scopeResolver,
    root: scopeResolver,
    topLevel: scopeResolver,
    loop: scopeResolver,
    call,
    effect: call,
    startsWith: stringResolver,
    endsWith: stringResolver,
    substring: stringResolver,
    toLowerCase: stringResolver,
    toUpperCase: stringResolver,
    split: stringResolver,
    isArray: simpleResolver(Array.isArray),
    eq: simpleResolver((a, b) => a === b),
    gt: simpleResolver((a, b) => a > b),
    gte: simpleResolver((a, b) => a >= b),
    lt: simpleResolver((a, b) => a < b),
    lte: simpleResolver((a, b) => a <= b),
    minus: simpleResolver((a, b) => a - b),
    plus: simpleResolver((a, b) => a + b),
    mult: simpleResolver((a, b) => a * b),
    div: simpleResolver((a, b) => a / b),
    mod: simpleResolver((a, b) => a % b),
    not: simpleResolver(a => !a),
    null: simpleResolver(() => null),
    floor: simpleResolver(a => Math.floor(a)),
    ceil: simpleResolver(a => Math.ceil(a)),
    round: simpleResolver(a => Math.round(a)),
    quote: simpleResolver(a => a),
    isUndefined: simpleResolver(a => typeof a === "undefined"),
    isBoolean: simpleResolver(a => typeof a === "boolean"),
    isNumber: simpleResolver(a => typeof a ==='number'),
    isString: simpleResolver(a => typeof a === 'string'),
    abstract: errorResolver,
    invoke: errorResolver,
    func: errorResolver,
    ternary,
    or,
    and,
    array,
    object,
    get: simpleResolver((obj, prop) => obj[prop]),
    stringLength: simpleResolver(a => a.length),
    parseInt: simpleResolver((a, radix) => parseInt(a, radix || 10)),
    map: topLevelResolver,
    mapValues: topLevelResolver,
    any: topLevelResolver,
    anyValues: topLevelResolver,
    recursiveMap: topLevelResolver,
    recursiveMapValues: topLevelResolver,
    filter: topLevelResolver,
    filterBy: topLevelResolver,
    keyBy: topLevelResolver,
    groupBy: topLevelResolver,
    mapKeys: topLevelResolver,
    size: topLevelNonPredicate,
    sum: topLevelNonPredicate,
    range,
    flatten: topLevelNonPredicate,
    assign: assignOrDefaults,
    defaults: assignOrDefaults,
    keys: keysOrValues,
    values: keysOrValues,
    trace,
    breakpoint,
    bind,
    recur,
    cond,
    arg0: argResolver,
    arg1: argResolver,
    arg2: argResolver,
    arg3: argResolver,
    arg4: argResolver,
    arg5: argResolver,
    arg6: argResolver,
    arg7: argResolver,
    arg8: argResolver,
    arg9: argResolver
};
const metaDataForEvaluator = new WeakMap <
    Evaluator,
    Partial < ProjectionMetaData >
    >
    ();
const buildEvaluator = (
    getter: GetterProjection,
    index: number
): Evaluator => {
    const [typeIndex, argRefs, getterMetadata] = getter;
    const md = metaData[getterMetadata];
    const type = primitives[typeIndex] as keyof typeof resolvers;
    const args = argRefs.map(resolveArgRef);
    if (!resolvers[type]) {
        throw new Error(`${type} is not implemented`);
    }
    const evaluator = (resolvers[type] as Resolver)(type, args, index, md);
    metaDataForEvaluator.set(evaluator, md);
    return evaluator;
};
const evaluators: Evaluator[] = getters.map(buildEvaluator);
const topLevelResults: ProjectionResult[] = [];
const resolvePretracking = (hasPath: boolean, conds ? : number[]): ((e: EvalScope) => EvalScope) => {
    const newConds = (conds || []).map(c => ({
        [c]: 0
    })).reduce((a, o) => ({
        ...a,
        o
    }), {})
    return (hasPath && conds && conds.length) ?
        (evalScope: EvalScope) =>
        ({
            ...evalScope,
            conds: {
                ...evalScope.conds,
                ...newConds
            }
        }) :
        (evalScope: EvalScope) => evalScope
}


const resolveTracking = ({
    paths
}: Partial < ProjectionMetaData > ) => {
    if (!paths || !paths.length) {
        return () => {}
    }

    const tracks: Evaluator[] = []

    paths.forEach(([cond, path]: [Reference, Reference[]]) => {
        const precond: Evaluator = cond ? resolveArgRef(cond) : () => true
        const pathToTrack: Evaluator[] = (path || []).map(resolveArgRef)
        const track = (scope: EvalScope) =>
            precond(scope) && library.trackPath(scope.runtimeState.$tracked, pathToTrack.map(p => p(scope)))
        tracks.push(track)
    })

    return (scope: EvalScope) => tracks.forEach(t => t(scope))
}

const topLevelEvaluators = topLevels.map(
    ([projectionIndex, name]: [number, string], index: number) => {
        const evaluator = evaluators[projectionIndex];
        const metaData = metaDataForEvaluator.get(evaluator) || {};
        const hasPaths = metaData && !!metaData.paths && !!metaData.paths.length
        const pretracking = resolvePretracking(hasPaths, metaData.trackedExpr || [])
        const tracking = resolveTracking(metaData)
        return (evalScope: EvalScope) => {
            evalScope = pretracking(evalScope);
            const result = evaluator(evalScope);
            topLevelResults[index] = result;
            if (name) {
                $res[name] = result;
            }
            tracking(evalScope);
            return result;
        };
    }
);

setters.forEach((s: SetterProjection) => {
    const [typeIndex, nameIndex, projections, numTokens] = s;
    const name = primitives[nameIndex];
    const type = primitives[typeIndex] as "push" | "splice" | "set";
    const path = projections.map(resolveArgRef);
    $res[name] = library.$setter.bind(null, (...args: any[]) =>
        library[type](
            path.map((arg: Evaluator) => arg({args} as EvalScope)),
            ...args.slice(numTokens)
        )
    );
});

function step({
    $first,
    $invalidatedRoots,
    $tainted,
    $model
}: StepParams) {
    const evalScope: EvalScope = {
        publicScope: {
            root: $model,
            topLevel: topLevelResults,
            key: null,
            val: null,
            context: null,
            loop: null
        },

        runtimeState: {
            $invalidatedRoots,
            $tracked: []
        },
        args: [],
        conds: {}
    };
    topLevelEvaluators.forEach((evaluator: Evaluator, i: number) => {
//        if ($first || $invalidatedRoots.has(i)) {
            const newValue = evaluator({
                ...evalScope,
                runtimeState: {
                    ...evalScope.runtimeState,
                    $tracked: [$invalidatedRoots, i]
                }
            });
            setOnArray(topLevelResults, i, newValue, true);
            if (!$first) {
                $invalidatedRoots.delete(i);
            }
//        }
    });
}

return {
    step
};
}