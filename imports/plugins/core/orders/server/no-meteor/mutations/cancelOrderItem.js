import SimpleSchema from "simpl-schema";
import ReactionError from "@reactioncommerce/reaction-error";
import Random from "@reactioncommerce/random";
import { Order as OrderSchema } from "/imports/collections/schemas";

const inputSchema = new SimpleSchema({
  cancelQuantity: SimpleSchema.Integer,
  itemId: String,
  orderId: String,
  reason: {
    type: String,
    optional: true
  }
});

/**
 * @method cancelOrderItem
 * @summary Cancels or partially cancels one order item
 * @param {Object} context - an object containing the per-request state
 * @param {Object} input - Necessary input. See SimpleSchema
 * @return {Promise<Object>} Object with `order` property containing the created order
 */
export default async function cancelOrderItem(context, input) {
  inputSchema.validate(input);

  const {
    orderId,
    itemId,
    cancelQuantity,
    reason
  } = input;

  const { appEvents, collections, userHasPermission, userId } = context;
  const { Orders } = collections;

  const order = await Orders.findOne({ _id: orderId });
  if (!order) throw new ReactionError("not-found", "Order not found");

  if (!userHasPermission(["orders"], order.shopId)) {
    throw new ReactionError("access-denied", "Access Denied");
  }

  // Find and cancel the item
  let foundItem = false;
  const updatedGroups = order.shipping.map((group) => {
    let itemToAdd;
    const updatedItems = group.items.map((item) => {
      if (item._id !== itemId) return item;
      foundItem = true;

      if (item.quantity > cancelQuantity) {
        itemToAdd = {
          ...item,
          _id: Random.id(),
          quantity: item.quantity - cancelQuantity
        };
      } else if (item.quantity < cancelQuantity) {
        throw new ReactionError("invalid-param", "cancelQuantity may not be greater than item quantity");
      }

      return {
        ...item,
        cancelReason: reason,
        quantity: cancelQuantity,
        workflow: {
          status: "coreOrderItemWorkflow/canceled",
          workflow: [...item.workflow.workflow, "coreOrderItemWorkflow/canceled"]
        }
      };
    });

    if (itemToAdd) {
      updatedItems.push(itemToAdd);
    }

    // If all items are canceled, set the group status to canceled
    let updatedGroupWorkflow = group.workflow;
    const allItemsAreCanceled = updatedItems.every((item) => item.workflow.status === "coreOrderItemWorkflow/canceled");
    if (allItemsAreCanceled) {
      updatedGroupWorkflow = {
        status: "coreOrderWorkflow/canceled",
        workflow: [...updatedGroupWorkflow.workflow, "coreOrderWorkflow/canceled"]
      };
    }

    return { ...group, items: updatedItems, workflow: updatedGroupWorkflow };
  });

  if (!foundItem) throw new ReactionError("not-found", "Order item not found");

  // If all groups are canceled, set the order status to canceled
  let updatedOrderWorkflow = order.workflow;
  let fullOrderWasCanceled = false;
  const allGroupsAreCanceled = updatedGroups.every((group) => group.workflow.status === "coreOrderWorkflow/canceled");
  if (allGroupsAreCanceled) {
    updatedOrderWorkflow = {
      status: "coreOrderWorkflow/canceled",
      workflow: [...updatedOrderWorkflow.workflow, "coreOrderWorkflow/canceled"]
    };
    fullOrderWasCanceled = true;
  }

  const modifier = {
    $set: {
      shipping: updatedGroups,
      updatedAt: new Date(),
      workflow: updatedOrderWorkflow
    }
  };

  OrderSchema.validate(modifier, { modifier: true });

  const { modifiedCount, value: updatedOrder } = await Orders.findOneAndUpdate(
    { _id: orderId },
    modifier,
    { returnOriginal: false }
  );
  if (modifiedCount === 0) throw new ReactionError("server-error", "Unable to update order");

  await appEvents.emit("afterOrderUpdate", {
    order: updatedOrder,
    updatedBy: userId
  });

  if (fullOrderWasCanceled) {
    await appEvents.emit("afterOrderCancel", {
      cancelledBy: userId,
      order: updatedOrder
    });
  }

  return { order: updatedOrder };
}